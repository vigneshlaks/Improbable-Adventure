import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

/**
 * Linear Counting: estimates how many different items were added, with one bit per bucket.
 * Accurate while the bit array is not close to full; it is exact-ish for small counts and fails when every bit is set.
 * Size it with `sizeLinearCounting` in sizing.ts.
 */
export class LinearCounting {
  readonly bits: number;
  readonly seed: number;
  private readonly cells: Uint8Array;
  private zeros: number;

  constructor(bits: number, seed = DEFAULT_SEED) {
    if (!(bits >= 1)) throw new RangeError("Linear Counting needs at least one bit");
    this.bits = Math.floor(bits);
    this.seed = seed;
    this.cells = new Uint8Array(Math.ceil(this.bits / 8));
    this.zeros = this.bits;
  }

  add(item: Item): void {
    const index = hash32(item, this.seed) % this.bits;
    const mask = 1 << (index & 7);
    if (((this.cells[index >>> 3] as number) & mask) === 0) {
      this.cells[index >>> 3] = (this.cells[index >>> 3] as number) | mask;
      this.zeros--;
    }
  }

  /** True when every bit is set: the estimate is then only a lower limit. */
  get saturated(): boolean {
    return this.zeros === 0;
  }

  /** The estimated number of different items: -m ln(share of bits still zero). */
  estimate(): number {
    if (this.zeros === 0) return this.bits * Math.log(this.bits);
    return -this.bits * Math.log(this.zeros / this.bits);
  }

  /** The expected standard error as a share of the true count, for an estimate of `count`. */
  standardError(count = this.estimate()): number {
    const load = count / this.bits;
    return Math.sqrt(this.bits * (Math.exp(load) - load - 1)) / count;
  }
}
