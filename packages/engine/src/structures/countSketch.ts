import { murmur3U32 } from "../hash/murmur3";
import { medianBandMultiplier } from "../stats/stats";
import { expectKind, optionsFromSnapshot, readCounts, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  COUNTER_BITS,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** Mixed into a row's seed to get the hash that picks the sign of a value in that row. */
const SIGN_SALT = 0x9e3779b9;
/** Counters are signed 32-bit numbers, kept in the snapshot with this offset so they stay non-negative integers. */
const SIGN_OFFSET = 2 ** 31;

/**
 * Count Sketch (Charikar, Chen and Farach-Colton): a grid of signed 32-bit counters, depth rows by width columns, sized
 * from Space. Each value goes to one counter per row, with a sign (+1 or -1) of its own in that row. An insert adds the sign,
 * a delete subtracts it, and the estimate is the median over the rows of sign x counter.
 *
 * Unlike Count-Min it is unbiased: collisions add and subtract, so they cancel on average, and it can answer
 * below the truth as well as above it. Its error scales with the stream's L2 norm over the square root of the width, so it
 * beats Count-Min when a few heavy values dominate and loses when many light values share counters. Deletes are exact.
 *
 * Each row has its own seeded hashes so rows collide independently.
 */
export class CountSketch implements Structure {
  readonly kind = "countSketch" as const;
  readonly params: Readonly<Record<string, number>>;

  private counters: Int32Array;
  private readonly width: number;
  private readonly depth: number;
  private readonly seed: number;
  private readonly rowSeeds: number[];

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.depth = Math.max(1, Math.floor(options.knob ?? constants.countSketchDefaultDepth));
    assertSpace("countSketch", options.spaceBits, COUNTER_BITS * this.depth);
    this.width = Math.floor(options.spaceBits / (COUNTER_BITS * this.depth));
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.rowSeeds = Array.from({ length: this.depth }, (_, row) => murmur3U32(row, this.seed));
    this.counters = new Int32Array(this.width * this.depth);
    this.params = { width: this.width, depth: this.depth };
  }

  spaceBits(): number {
    return COUNTER_BITS * this.width * this.depth;
  }

  private slot(row: number, value: number): number {
    return row * this.width + (murmur3U32(value, this.rowSeeds[row] as number) % this.width);
  }

  private sign(row: number, value: number): 1 | -1 {
    return (murmur3U32(value, ((this.rowSeeds[row] as number) ^ SIGN_SALT) >>> 0) & 1) === 0 ? 1 : -1;
  }

  ingest(event: StreamEvent): void {
    const delta = event.op === "insert" ? 1 : -1;
    for (let row = 0; row < this.depth; row++) {
      const slot = this.slot(row, event.value);
      this.counters[slot] = ((this.counters[slot] as number) + delta * this.sign(row, event.value)) | 0;
    }
  }

  /** The median over the rows of sign x counter, which may be fractional (an even depth averages the middle two) or below zero. */
  rawEstimate(value: number): number {
    const readings: number[] = [];
    for (let row = 0; row < this.depth; row++) readings.push(this.sign(row, value) * (this.counters[this.slot(row, value)] as number));
    readings.sort((a, b) => a - b);
    const middle = this.depth >> 1;
    return this.depth % 2 === 1 ? (readings[middle] as number) : ((readings[middle - 1] as number) + (readings[middle] as number)) / 2;
  }

  estimate(value: number): number {
    return Math.max(0, this.rawEstimate(value));
  }

  /** The stream's squared L2 norm, estimated as the median over the rows of the sum of squared counters (each row's sum is unbiased). */
  get squaredNorm(): number {
    const sums: number[] = [];
    for (let row = 0; row < this.depth; row++) {
      let sum = 0;
      for (let col = 0; col < this.width; col++) sum += (this.counters[row * this.width + col] as number) ** 2;
      sums.push(sum);
    }
    sums.sort((a, b) => a - b);
    const middle = this.depth >> 1;
    return this.depth % 2 === 1 ? (sums[middle] as number) : ((sums[middle - 1] as number) + (sums[middle] as number)) / 2;
  }

  /**
   * How far an estimate is likely to be off, either way: a row's error has variance at most the squared norm over the
   * width, so by Chebyshev it exceeds m typical errors with chance 1 / m^2, and the median only does so when at least half
   * the rows do. `m` is the smallest multiple for which that is at most 1 - confidence.
   */
  get errorBand(): number {
    return medianBandMultiplier(this.depth, this.constants.confidence) * Math.sqrt(this.squaredNorm / this.width);
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "frequency") return null;
    const est = this.estimate(challenge.value);
    const band = this.errorBand;
    return { estimate: est, low: Math.max(0, est - band), high: est + band, confidence: this.constants.confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { counters: Array.from(this.counters, (c) => c + SIGN_OFFSET) },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): CountSketch {
    expectKind(snapshot, "countSketch");
    const sketch = new CountSketch(optionsFromSnapshot(snapshot), constants);
    const stored = readCounts(snapshot.state, "counters", sketch.counters.length);
    sketch.counters = Int32Array.from(stored, (c) => c - SIGN_OFFSET);
    return sketch;
  }

  clone(): CountSketch {
    const copy = new CountSketch(this.options, this.constants);
    copy.counters = new Int32Array(this.counters);
    return copy;
  }

  merge(other: Structure): CountSketch {
    if (!(other instanceof CountSketch) || other.width !== this.width || other.depth !== this.depth || other.seed !== this.seed) {
      throw new Error("Count Sketches merge only with same-shaped, same-seeded sketches");
    }
    const merged = this.clone();
    for (let i = 0; i < merged.counters.length; i++) merged.counters[i] = ((merged.counters[i] as number) + (other.counters[i] as number)) | 0;
    return merged;
  }
}
