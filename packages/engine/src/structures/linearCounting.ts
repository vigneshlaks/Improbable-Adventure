import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
} from "./types";

/**
 * Linear Counting: a bitmap of m = Space bits where each value sets one bit. The share of bits still
 * zero reveals how many distinct values were seen. Once no zero bits remain it can only give a lower
 * bound, so its upper bound is infinite. Cannot delete.
 */
export class LinearCounting implements Structure {
  readonly kind = "linearCounting" as const;
  readonly params: Readonly<Record<string, number>>;

  private bits: Uint8Array;
  private zeros: number;
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

  ingest(event: StreamEvent): void {
    if (event.op !== "insert") return; // Linear Counting cannot delete
    const idx = murmur3U32(event.value, this.seed) % this.m;
    const byte = idx >>> 3;
    const mask = 1 << (idx & 7);
    const current = this.bits[byte] ?? 0;
    if ((current & mask) === 0) {
      this.bits[byte] = current | mask;
      this.zeros--;
    }
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "count") return null;
    const confidence = this.constants.confidence;
    if (this.zeros === 0) {
      const floor = this.m * Math.log(this.m);
      return { estimate: floor, low: floor, high: Number.POSITIVE_INFINITY, confidence };
    }
    const est = -this.m * Math.log(this.zeros / this.m);
    const t = est / this.m;
    const se = Math.sqrt(this.m * (Math.exp(t) - t - 1));
    const z = zForConfidence(confidence);
    return { estimate: est, low: Math.max(0, est - z * se), high: est + z * se, confidence };
  }

  clone(): LinearCounting {
    const copy = new LinearCounting(this.options, this.constants);
    copy.bits = new Uint8Array(this.bits);
    copy.zeros = this.zeros;
    return copy;
  }
}
