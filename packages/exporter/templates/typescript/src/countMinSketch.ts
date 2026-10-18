import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

const COUNTER_MAX = 0xffffffff;

/**
 * Count-Min Sketch: estimates how many times each item was added, in a fixed grid of counters.
 * It never underestimates; it overshoots by at most about (e / width) x total, with probability 1 - e^-depth.
 * Items can be removed, but only items that were added. Size it with `sizeCountMin` in sizing.ts.
 */
export class CountMinSketch {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  private readonly counters: Uint32Array;
  private readonly rowSeeds: number[];
  private total = 0;

  constructor(width: number, depth: number, seed = DEFAULT_SEED) {
    if (!(width >= 1) || !(depth >= 1)) throw new RangeError("A Count-Min Sketch needs at least one column and one row");
    this.width = Math.floor(width);
    this.depth = Math.floor(depth);
    this.seed = seed;
    this.counters = new Uint32Array(this.width * this.depth);
    this.rowSeeds = Array.from({ length: this.depth }, (_, row) => hash32(row, seed)); // each row hashes independently
  }

  private slot(row: number, item: Item): number {
    return row * this.width + (hash32(item, this.rowSeeds[row] as number) % this.width);
  }

  add(item: Item, count = 1): void {
    for (let row = 0; row < this.depth; row++) {
      const slot = this.slot(row, item);
      this.counters[slot] = Math.min(COUNTER_MAX, (this.counters[slot] as number) + count);
    }
    this.total += count;
  }

  /** Takes back `count` earlier additions of the item. Removing something never added makes other estimates wrong. */
  remove(item: Item, count = 1): void {
    for (let row = 0; row < this.depth; row++) {
      const slot = this.slot(row, item);
      this.counters[slot] = Math.max(0, (this.counters[slot] as number) - count);
    }
    this.total = Math.max(0, this.total - count);
  }

  /** At least the true count, and usually close to it. */
  estimate(item: Item): number {
    let best = COUNTER_MAX;
    for (let row = 0; row < this.depth; row++) best = Math.min(best, this.counters[this.slot(row, item)] as number);
    return best;
  }

  /** How far an estimate is likely to overshoot: (e / width) x total. */
  get overshoot(): number {
    return (Math.E / this.width) * this.total;
  }
}
