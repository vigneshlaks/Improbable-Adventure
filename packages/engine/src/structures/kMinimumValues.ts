import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
import { liveCountRange, type CountRange } from "./ghosts";
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

/** The hashes are 32-bit numbers, so the largest is this and a hash divided by it is a share of the range. */
const HASH_RANGE = 2 ** 32;

/**
 * K-Minimum Values (Bar-Yossef and others): keep the k smallest hashes of the distinct values seen. If fewer than k different
 * values have been seen, the count is exact. Otherwise the k-th smallest hash, as a share u of the hash range, says how crowded the
 * values are: with n values the k smallest hashes fill about k / n of the range, so the estimate is (k - 1) / u, which is unbiased,
 * with a relative standard error of about 1 / sqrt(k - 2).
 *
 * It costs VALUE_BITS per kept hash, ignores deletes (a deleted value stays in the table as a ghost, so it handles them as LogLog and
 * Linear Counting do, see `liveCountRange`), and two sketches of the same size and seed merge into the sketch of the union of their
 * streams: the k smallest hashes of both.
 */
export class KMinimumValues implements Structure {
  readonly kind = "kMinimumValues" as const;
  readonly params: Readonly<Record<string, number>>;

  private sorted: number[] = [];
  private insertCount = 0;
  private deleteCount = 0;
  private readonly k: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("kMinimumValues", options.spaceBits, 3 * constants.valueBits);
    this.k = Math.floor(options.spaceBits / constants.valueBits);
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.params = { k: this.k };
  }

  spaceBits(): number {
    return this.k * this.constants.valueBits;
  }

  /** The kept hashes, smallest first. */
  get hashes(): readonly number[] {
    return this.sorted;
  }

  /** How many hashes are kept (at most k). */
  get size(): number {
    return this.sorted.length;
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The expected relative standard error: 0 while it holds every value, otherwise 1 / sqrt(k - 2). */
  get standardError(): number {
    return this.sorted.length < this.k ? 0 : 1 / Math.sqrt(this.k - 2);
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // it cannot take a value back out, but it can count the departure
      return;
    }
    this.insertCount++;
    const hash = murmur3U32(event.value, this.seed);
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.sorted[mid] as number) < hash) low = mid + 1;
      else high = mid;
    }
    if (this.sorted[low] === hash) return; // a value already kept
    if (this.sorted.length < this.k) this.sorted.splice(low, 0, hash);
    else if (low < this.k) {
      this.sorted.splice(low, 0, hash);
      this.sorted.pop();
    }
  }

  /** The estimate of the distinct values ever inserted. */
  estimate(): number {
    if (this.sorted.length < this.k) return this.sorted.length;
    return (this.k - 1) / ((this.sorted[this.k - 1] as number) / HASH_RANGE);
  }

  /** The range for the values ever inserted. The relative error is lopsided (the estimate is an inverse), so the range is lognormal, as LogLog's is. */
  private everRange(confidence: number): CountRange {
    const est = this.estimate();
    if (this.sorted.length < this.k) return { estimate: est, low: est, high: est };
    const sigmaLn = Math.sqrt(Math.log(1 + this.standardError ** 2));
    const centre = (sigmaLn * sigmaLn) / 2;
    const z = zForConfidence(confidence);
    return { estimate: est, low: est * Math.exp(centre - z * sigmaLn), high: est * Math.exp(centre + z * sigmaLn) };
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "count") return null;
    const confidence = this.constants.confidence;
    return { ...liveCountRange((c) => this.everRange(c), this.insertCount, this.deleteCount, confidence), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { hashes: [...this.sorted], inserts: this.insertCount, deletes: this.deleteCount },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): KMinimumValues {
    expectKind(snapshot, "kMinimumValues");
    const sketch = new KMinimumValues(optionsFromSnapshot(snapshot), constants);
    const hashes = readCounts(snapshot.state, "hashes");
    if (hashes.length > sketch.k) throw new RangeError('Bad snapshot: "hashes" exceeds k');
    for (let i = 1; i < hashes.length; i++) if ((hashes[i] as number) <= (hashes[i - 1] as number)) throw new RangeError('Bad snapshot: "hashes" must be strictly increasing');
    sketch.sorted = [...hashes];
    sketch.insertCount = readNumber(snapshot.state, "inserts");
    sketch.deleteCount = readNumber(snapshot.state, "deletes");
    return sketch;
  }

  clone(): KMinimumValues {
    const copy = new KMinimumValues(this.options, this.constants);
    copy.sorted = [...this.sorted];
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }

  merge(other: Structure): KMinimumValues {
    if (!(other instanceof KMinimumValues) || other.k !== this.k || other.seed !== this.seed) {
      throw new Error("K-Minimum Values merge only with same-sized, same-seeded sketches");
    }
    const merged = this.clone();
    merged.sorted = [...new Set([...this.sorted, ...other.sorted])].sort((a, b) => a - b).slice(0, this.k);
    merged.insertCount = this.insertCount + other.insertCount;
    merged.deleteCount = this.deleteCount + other.deleteCount;
    return merged;
  }
}
