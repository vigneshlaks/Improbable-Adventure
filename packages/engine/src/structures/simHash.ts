import { murmur3U32 } from "../hash/murmur3";
import { binomialUpper } from "../stats/stats";
import { deletedShare } from "./ghosts";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** A fingerprint is this many bits, and a SimHash holds at least one. */
const FINGERPRINT_BITS = 64;
/** Spaces out the seeds of the hash functions that give the planes' signs. */
const GROUP_SALT = 0x9e3779b1;

/**
 * SimHash (Charikar): the angle between two sets, from the signs of random projections. Each of P planes has a sign for every value
 * (a bit of its hash), and keeps a counter of the signs of the values it has seen. The fingerprint is the sign of each counter. A copy gets
 * its fingerprint the same way, and the share of planes where the two signs differ estimates the angle between the stream's count vector
 * and the copy's indicator vector divided by pi. The cosine of that angle is shared / sqrt(stream size x copy size) for sets, so with
 * the sizes the similarity follows: shared I = cos x sqrt(s c), Jaccard I / (s + c - I).
 *
 * The stream's size s is its effective number of values, n^2 over the sum of squared counts, which the counters give (their mean square is
 * the sum of squared counts): exact when every value repeats equally often and too small when a few repeat a lot, since the repeats weigh the
 * counters. It is weak on duplicates, as the spec says. It ignores deletes, which it counts. The Space buys
 * Space / `simHashCounterBits` planes (at least one 64-bit fingerprint's worth), against MinHash's Space / 32 slots, but a plane says
 * less than a slot: the angle is only roughly the Jaccard similarity.
 */
export class SimHash implements Structure {
  readonly kind = "simHash" as const;
  readonly params: Readonly<Record<string, number>>;

  private counters: Int32Array;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly planes: number;
  private readonly seed: number;
  private readonly cap: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    const bits = constants.simHashCounterBits;
    assertSpace("simHash", options.spaceBits, FINGERPRINT_BITS * bits);
    this.planes = Math.floor(options.spaceBits / bits / 32) * 32; // whole 32-bit hashes of signs
    this.cap = 2 ** (bits - 1) - 1;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.counters = new Int32Array(this.planes);
    this.params = { planes: this.planes };
  }

  spaceBits(): number {
    return this.planes * this.constants.simHashCounterBits;
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The signs a value gives to the planes: +1 or -1 for each. */
  private signs(value: number): Int8Array {
    const out = new Int8Array(this.planes);
    for (let group = 0; group < this.planes / 32; group++) {
      const hash = murmur3U32(value, (this.seed + Math.imul(group + 1, GROUP_SALT)) >>> 0);
      for (let bit = 0; bit < 32; bit++) out[group * 32 + bit] = (hash >>> bit) & 1 ? 1 : -1;
    }
    return out;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // it cannot take a value out of the sums, but it can count the departure
      return;
    }
    this.insertCount++;
    const signs = this.signs(event.value);
    for (let i = 0; i < this.planes; i++) this.counters[i] = Math.max(-this.cap, Math.min(this.cap, (this.counters[i] as number) + (signs[i] as number)));
  }

  /** The counter of every plane (positive: more +1 signs than -1). */
  get counterValues(): readonly number[] {
    return Array.from(this.counters);
  }

  /** The effective number of values in the stream: n^2 over the sum of squared counts, which a plane's squared counter estimates. */
  effectiveSize(): number {
    if (this.insertCount === 0) return 0;
    let squares = 0;
    for (const c of this.counters) squares += c * c;
    const meanSquare = squares / this.planes;
    return meanSquare <= 0 ? this.insertCount : Math.max(1, Math.min(this.insertCount, this.insertCount ** 2 / meanSquare));
  }

  /** The share of planes whose sign differs between the stream and the set of values: the estimate of its angle over pi. */
  differing(values: readonly number[]): number {
    const sums = new Int32Array(this.planes);
    for (const value of new Set(values)) {
      const signs = this.signs(value);
      for (let i = 0; i < this.planes; i++) sums[i] = (sums[i] as number) + (signs[i] as number);
    }
    let differ = 0;
    for (let i = 0; i < this.planes; i++) if (((this.counters[i] as number) >= 0) !== ((sums[i] as number) >= 0)) differ++;
    return differ / this.planes;
  }

  /** The Jaccard similarity that goes with an angle (as a share of pi), for a stream of `streamSize` and a copy of `copySize` values. */
  static similarityAt(share: number, streamSize: number, copySize: number): number {
    const shared = Math.max(0, Math.min(streamSize, copySize, Math.cos(Math.PI * share) * Math.sqrt(streamSize * copySize)));
    const union = streamSize + copySize - shared;
    return union <= 0 ? 1 : shared / union;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "likeness") return null;
    const confidence = this.constants.confidence;
    const miss = 1 - confidence;
    const n = this.insertCount;
    const size = this.effectiveSize();
    const copies = challenge.copies.length;
    const halfWidth = Math.sqrt(Math.log((2 * copies) / (miss / 2)) / (2 * this.planes));
    // Ghosts: the units deleted since are still in the sums. As a share of the units seen, at most this many values are ghosts.
    const ghostShare = this.deleteCount > 0 && n > 0 ? Math.min(1, binomialUpper(n, deletedShare(n, this.deleteCount), 1 - miss / 4) / n) : 0;
    const flagged: number[] = [];
    let surelyReal = 0;
    challenge.copies.forEach((copy, index) => {
      const copySize = new Set(copy).size;
      const share = this.differing(copy);
      const estimate = SimHash.similarityAt(share, size, copySize);
      if (estimate < challenge.threshold) return;
      flagged.push(challenge.targets[index] as number);
      // The most similar the copy can be, over the stream's live values: the least it can be is the angle's far end, less the ghosts.
      const lowest = SimHash.similarityAt(Math.min(0.5, share + halfWidth), size, copySize);
      if (lowest - ghostShare >= challenge.threshold) surelyReal++;
    });
    return { estimate: flagged, low: surelyReal, high: flagged.length, confidence };
  }

  snapshot(): StructureSnapshot {
    return { ...snapshotHeader(this.kind, this.options), state: { counters: Array.from(this.counters, (c) => c + this.cap), inserts: this.insertCount, deletes: this.deleteCount } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): SimHash {
    expectKind(snapshot, "simHash");
    const sketch = new SimHash(optionsFromSnapshot(snapshot), constants);
    const stored = readCounts(snapshot.state, "counters", sketch.planes);
    sketch.counters = Int32Array.from(stored, (c) => c - sketch.cap); // stored with an offset so that every entry is a non-negative integer
    sketch.insertCount = readNumber(snapshot.state, "inserts");
    sketch.deleteCount = readNumber(snapshot.state, "deletes");
    return sketch;
  }

  clone(): SimHash {
    const copy = new SimHash(this.options, this.constants);
    copy.counters = new Int32Array(this.counters);
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}
