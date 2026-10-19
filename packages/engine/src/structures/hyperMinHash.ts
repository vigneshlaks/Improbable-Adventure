import { murmur3U32 } from "../hash/murmur3";
import { binomialUpper, zForConfidence } from "../stats/stats";
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

/** Bits of the position of the first one bit in a register. */
const RANK_BITS = 5;
/** The fewest registers worth having. */
const MIN_REGISTERS = 16;
/** Seeds the reference set that estimates the chance two unrelated registers agree. */
const REFERENCE_BASE = 3_500_000_000;
/** The bias correction of HyperLogLog's harmonic mean. */
const alpha = (m: number) => (m >= 128 ? 0.7213 / (1 + 1.079 / m) : m >= 64 ? 0.709 : m >= 32 ? 0.697 : 0.673);

/**
 * HyperMinHash (Yu and Weber): MinHash laid out like a HyperLogLog. Each value's hash is cut into a bucket (its first b bits), the position
 * of the first one bit among the rest (as in HyperLogLog) and the q bits after that one (a mantissa). A register keeps the smallest hash of
 * its bucket, in that coded form: the position and the mantissa, 5 + q bits. So there are Space / (5 + q) registers (a power of two), against
 * MinHash's Space / 32 slots, and an insert touches one register, not all of them: about four times the registers for the same Space, and the
 * same registers give a count, as a HyperLogLog does (which is how it knows how many values it holds).
 *
 * Two sets agree in a bucket when the smallest hash of the union is in both, which has the chance of their Jaccard similarity J, or when
 * two different smallest hashes happen to have the same code, which has a chance p that the structure measures: it builds a reference set
 * of the copy's size from values outside the stream's universe and counts how often its registers agree with the stream's. Then
 * (agreeing / buckets either set uses - p) / (1 - p) estimates J. It ignores deletes like the other MinHashes, with the same ghost allowance.
 */
export class HyperMinHash implements Structure {
  readonly kind = "hyperMinHash" as const;
  readonly params: Readonly<Record<string, number>>;

  private registers: Uint16Array;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly b: number;
  private readonly m: number;
  private readonly q: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.q = constants.hyperMinHashMantissaBits;
    const registerBits = RANK_BITS + this.q;
    assertSpace("hyperMinHash", options.spaceBits, registerBits * MIN_REGISTERS);
    this.b = Math.floor(Math.log2(options.spaceBits / registerBits));
    this.m = 2 ** this.b;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.registers = new Uint16Array(this.m);
    this.params = { registers: this.m, indexBits: this.b, registerBits };
  }

  spaceBits(): number {
    return this.m * (RANK_BITS + this.q);
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The code of a value: its bucket, and the position and mantissa of its hash, arranged so that a larger code is a smaller hash. 0 is an empty register. */
  private place(value: number): { bucket: number; code: number } {
    const h = murmur3U32(value, this.seed);
    const bucket = h >>> (32 - this.b);
    const rest = (h << this.b) >>> 0;
    const rank = Math.min(2 ** RANK_BITS - 1, rest === 0 ? 33 - this.b : Math.clz32(rest) + 1);
    const mantissa = rest === 0 || rank >= 32 ? 0 : ((rest << rank) >>> (32 - this.q)) & (2 ** this.q - 1);
    return { bucket, code: rank * 2 ** this.q + (2 ** this.q - 1 - mantissa) + 1 };
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++;
      return;
    }
    this.insertCount++;
    const { bucket, code } = this.place(event.value);
    if (code > (this.registers[bucket] as number)) this.registers[bucket] = code;
  }

  /** The registers of a set of values, made with this structure's hash. */
  registersOf(values: readonly number[]): Uint16Array {
    const out = new Uint16Array(this.m);
    for (const value of new Set(values)) {
      const { bucket, code } = this.place(value);
      if (code > (out[bucket] as number)) out[bucket] = code;
    }
    return out;
  }

  /** The buckets some set uses and the buckets where both agree, for the stream and a set of registers. */
  private compare(other: Uint16Array): { used: number; agree: number } {
    let used = 0;
    let agree = 0;
    for (let i = 0; i < this.m; i++) {
      const mine = this.registers[i] as number;
      const theirs = other[i] as number;
      if (mine === 0 && theirs === 0) continue;
      used++;
      if (mine === theirs) agree++;
    }
    return { used, agree };
  }

  /**
   * The number of distinct values ever inserted, as a HyperLogLog counts them from the position part of the registers, and a lower bound for it
   * at a one-sided confidence (the relative error is 1.04 / sqrt(m)).
   */
  distinctEver(confidence: number): { estimate: number; low: number } {
    if (this.insertCount === 0) return { estimate: 0, low: 0 };
    let sum = 0;
    let empty = 0;
    for (const code of this.registers) {
      if (code === 0) {
        empty++;
        sum += 1;
      } else sum += 2 ** -Math.floor((code - 1) / 2 ** this.q);
    }
    let estimate = (alpha(this.m) * this.m * this.m) / sum;
    if (estimate <= 2.5 * this.m && empty > 0) estimate = this.m * Math.log(this.m / empty);
    const sigma = 1.04 / Math.sqrt(this.m);
    return { estimate, low: estimate * Math.exp(-zForConfidence(1 - 2 * (1 - confidence)) * sigma) };
  }

  /** The estimated similarity of a copy to the values ever inserted, and the chance of two unrelated registers agreeing that it was corrected by. */
  assessCopy(copy: readonly number[], reference: Uint16Array): { similarity: number; collision: number; agreeShare: number; used: number } {
    const { used, agree } = this.compare(this.registersOf(copy));
    const { used: refUsed, agree: refAgree } = this.compare(reference);
    const collision = refUsed === 0 ? 0 : refAgree / refUsed;
    const agreeShare = used === 0 ? 0 : agree / used;
    return { similarity: Math.max(0, Math.min(1, (agreeShare - collision) / (1 - collision))), collision, agreeShare, used };
  }

  /** A set of `size` values outside any the game uses, to measure how often unrelated registers agree. */
  private referenceFor(size: number): Uint16Array {
    return this.registersOf(Array.from({ length: Math.max(1, size) }, (_, i) => REFERENCE_BASE + i));
  }

  assess(challenge: Extract<Challenge, { kind: "likeness" }>): Array<{ target: number; similarity: number; surelyReal: boolean }> {
    const confidence = this.constants.confidence;
    const miss = 1 - confidence;
    const copies = challenge.copies.length;
    const meanSize = Math.round(challenge.copies.reduce((sum, copy) => sum + new Set(copy).size, 0) / Math.max(1, copies));
    const reference = this.referenceFor(meanSize);

    let ghostShare = 0;
    if (this.deleteCount > 0) {
      const n = Math.max(1, Math.floor(this.distinctEver(1 - miss / 4).low));
      const ghosts = Math.min(this.deleteCount, binomialUpper(n, deletedShare(this.insertCount, this.deleteCount), 1 - miss / 4));
      ghostShare = Math.min(1, ghosts / n);
    }
    return challenge.copies.map((copy, index) => {
      const { similarity, collision, agreeShare, used } = this.assessCopy(copy, reference);
      // Hoeffding for the share of agreeing buckets (the miss chance's first half, shared between the copies) and for the collision chance
      // measured on the reference (a quarter); the least the similarity can be is the least agreement over the most collision.
      const n = Math.max(1, used);
      const eAgree = Math.sqrt(Math.log((2 * copies) / (miss / 2)) / (2 * n));
      const eCollision = Math.sqrt(Math.log(2 / (miss / 4)) / (2 * Math.max(1, used)));
      const worstCollision = Math.min(0.999, collision + eCollision);
      const least = Math.max(0, (agreeShare - eAgree - worstCollision) / (1 - worstCollision));
      return { target: challenge.targets[index] as number, similarity, surelyReal: least - ghostShare >= challenge.threshold };
    });
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "likeness") return null;
    const flagged = this.assess(challenge).filter((copy) => copy.similarity >= challenge.threshold);
    return { estimate: flagged.map((copy) => copy.target), low: flagged.filter((copy) => copy.surelyReal).length, high: flagged.length, confidence: this.constants.confidence };
  }

  snapshot(): StructureSnapshot {
    return { ...snapshotHeader(this.kind, this.options), state: { registers: Array.from(this.registers), inserts: this.insertCount, deletes: this.deleteCount } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): HyperMinHash {
    expectKind(snapshot, "hyperMinHash");
    const sketch = new HyperMinHash(optionsFromSnapshot(snapshot), constants);
    sketch.registers = Uint16Array.from(readCounts(snapshot.state, "registers", sketch.m));
    sketch.insertCount = readNumber(snapshot.state, "inserts");
    sketch.deleteCount = readNumber(snapshot.state, "deletes");
    return sketch;
  }

  clone(): HyperMinHash {
    const copy = new HyperMinHash(this.options, this.constants);
    copy.registers = new Uint16Array(this.registers);
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}
