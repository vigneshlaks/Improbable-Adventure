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

/**
 * Linear Counting: a bitmap of m = Space bits where each value sets one bit. The share of bits still
 * zero reveals how many distinct values were seen. Once no zero bits remain it can only give a lower
 * bound, so its upper bound is infinite. Cannot delete, so it counts values that were deleted since (ghosts).
 * It counts the inserts and deletes it sees and lowers its range's low bound by the ghosts they allow.
 */
export class LinearCounting implements Structure {
  readonly kind = "linearCounting" as const;
  readonly params: Readonly<Record<string, number>>;

  private bits: Uint8Array;
  private zeros: number;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly m: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("linearCounting", options.spaceBits, 2);
    this.m = options.spaceBits;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
    this.zeros = this.m;
    this.params = { m: this.m };
  }

  spaceBits(): number {
    return this.m;
  }

  get zeroBits(): number {
    return this.zeros;
  }

  get saturated(): boolean {
    return this.zeros === 0;
  }

  /** Insert events seen. */
  get inserts(): number {
    return this.insertCount;
  }

  /** Delete events seen and ignored. Each ghost needs at least one, so there are never more ghosts than this. */
  get deletes(): number {
    return this.deleteCount;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // it cannot clear the bit, but it can count the departure
      return;
    }
    this.insertCount++;
    const idx = murmur3U32(event.value, this.seed) % this.m;
    const byte = idx >>> 3;
    const mask = 1 << (idx & 7);
    const current = this.bits[byte] ?? 0;
    if ((current & mask) === 0) {
      this.bits[byte] = current | mask;
      this.zeros--;
    }
  }

  /** The range for the distinct values ever inserted, at a two-sided confidence. */
  private everRange(confidence: number): CountRange {
    if (this.zeros === 0) {
      const floor = this.m * Math.log(this.m);
      return { estimate: floor, low: floor, high: Number.POSITIVE_INFINITY };
    }
    const est = -this.m * Math.log(this.zeros / this.m);
    const t = est / this.m;
    const se = Math.sqrt(this.m * (Math.exp(t) - t - 1));
    const z = zForConfidence(confidence);
    return { estimate: est, low: Math.max(0, est - z * se), high: est + z * se };
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "count") return null;
    const confidence = this.constants.confidence;
    return { ...liveCountRange((c) => this.everRange(c), this.insertCount, this.deleteCount, confidence), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { bits: Array.from(this.bits), zeros: this.zeros, inserts: this.insertCount, deletes: this.deleteCount },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): LinearCounting {
    expectKind(snapshot, "linearCounting");
    const counter = new LinearCounting(optionsFromSnapshot(snapshot), constants);
    counter.bits = Uint8Array.from(readCounts(snapshot.state, "bits", counter.bits.length));
    counter.zeros = readNumber(snapshot.state, "zeros");
    counter.insertCount = readNumber(snapshot.state, "inserts");
    counter.deleteCount = readNumber(snapshot.state, "deletes");
    return counter;
  }

  clone(): LinearCounting {
    const copy = new LinearCounting(this.options, this.constants);
    copy.bits = new Uint8Array(this.bits);
    copy.zeros = this.zeros;
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}
