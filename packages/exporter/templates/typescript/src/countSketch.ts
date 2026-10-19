import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

/** Mixed into a row's seed to get the hash that picks the sign of an item in that row. */
const SIGN_SALT = 0x9e3779b9;

/**
 * Count Sketch: estimates how many times each item was added, in a grid of signed counters.
 * An item goes to one counter in every row with a sign of +1 or -1 of its own there, so other items' collisions add and subtract and
 * cancel on average: the estimate is unbiased, and can be below the truth as well as above it. The estimate is the median over the rows.
 * Its error follows the stream's L2 norm (the square root of the sum of squared counts), so it beats a Count-Min Sketch when a few items
 * are heavy. Items can be removed. Size it with `sizeCountSketch` in sizing.ts.
 */
export class CountSketch {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  private readonly counters: Int32Array;
  private readonly rowSeeds: number[];

  constructor(width: number, depth: number, seed = DEFAULT_SEED) {
    if (!(width >= 1) || !(depth >= 1)) throw new RangeError("A Count Sketch needs at least one column and one row");
    this.width = Math.floor(width);
    this.depth = Math.floor(depth);
    this.seed = seed;
    this.counters = new Int32Array(this.width * this.depth);
    this.rowSeeds = Array.from({ length: this.depth }, (_, row) => hash32(row, seed)); // each row hashes independently
  }

  private slot(row: number, item: Item): number {
    return row * this.width + (hash32(item, this.rowSeeds[row] as number) % this.width);
  }

  private sign(row: number, item: Item): 1 | -1 {
    return (hash32(item, ((this.rowSeeds[row] as number) ^ SIGN_SALT) >>> 0) & 1) === 0 ? 1 : -1;
  }

  add(item: Item, count = 1): void {
    for (let row = 0; row < this.depth; row++) {
      const slot = this.slot(row, item);
      this.counters[slot] = ((this.counters[slot] as number) + count * this.sign(row, item)) | 0;
    }
  }

  /** Takes back `count` earlier additions. Exact: a removed item leaves no trace. */
  remove(item: Item, count = 1): void {
    this.add(item, -count);
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  }

  /** The median over the rows of sign x counter: may be fractional (an even depth averages the middle two) or below zero. */
  rawEstimate(item: Item): number {
    return this.median(Array.from({ length: this.depth }, (_, row) => this.sign(row, item) * (this.counters[this.slot(row, item)] as number)));
  }

  /** The estimate of the count, never below zero. */
  estimate(item: Item): number {
    return Math.max(0, this.rawEstimate(item));
  }

  /** The squared L2 norm of the counts added, estimated as the median over the rows of the sum of squared counters. */
  get squaredNorm(): number {
    return this.median(
      Array.from({ length: this.depth }, (_, row) => {
        let sum = 0;
        for (let col = 0; col < this.width; col++) sum += (this.counters[row * this.width + col] as number) ** 2;
        return sum;
      }),
    );
  }

  /**
   * How far an estimate is off, either way, in the worst case the sizing plans for: twice the typical row error,
   * `2 sqrt(squared norm / width)`, which is `error x L2 norm` for a sketch sized by `sizeCountSketch`.
   */
  get errorBand(): number {
    return 2 * Math.sqrt(this.squaredNorm / this.width);
  }
}
