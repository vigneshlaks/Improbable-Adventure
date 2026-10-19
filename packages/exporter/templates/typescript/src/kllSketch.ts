import { DEFAULT_SEED, hash32 } from "./hash.ts";

/** The least a level can hold. */
const MIN_LEVEL = 2;
/** Mixed into the seed to get the coin a compaction flips. */
const COIN_SALT = 0x6a09e667;

/**
 * KLL Sketch (Karnin, Lang and Liberty): estimates quantiles (the median, the 99th percentile, the rank of a value) of a stream of numbers in a
 * few kilobytes. Items are kept in levels; an item at level l stands for 2^l items. When a level is over its capacity it is sorted and every
 * second item (from a coin) is promoted to the level above and the rest dropped, so the ranks of the survivors stay right on average. The rank
 * error is the same at every quantile and shrinks with k: about 1.6 / k of the items (the 95th percentile of the error, found by simulation). The
 * sketch holds about 3k numbers however long the stream. Adding is by value; items cannot be removed. Two sketches of the same k and seed merge.
 * The coin is a hash of a counter, not a random generator, so the same stream always makes the same sketch. Size it with `sizeKll` in sizing.ts.
 */
export class KllSketch {
  readonly k: number;
  readonly seed: number;
  private levels: number[][] = [[]];
  private compactions = 0;
  private added = 0;

  constructor(k: number, seed = DEFAULT_SEED) {
    if (!(k >= 2)) throw new RangeError("A KLL Sketch needs k of at least 2");
    this.k = Math.floor(k);
    this.seed = seed;
  }

  /** Items added. */
  get count(): number {
    return this.added;
  }

  /** The items now stored, each with the number of items it stands for, in ascending order of value. */
  get items(): Array<{ value: number; weight: number }> {
    return this.levels.flatMap((level, l) => level.map((value) => ({ value, weight: 2 ** l }))).sort((a, b) => a.value - b.value);
  }

  private capacityOf(level: number): number {
    // k x (2/3)^depth rounded up, worked out in whole numbers: a power of 2/3 is not exact, and a result a hair under a whole number would round the other way on another machine.
    const depth = this.levels.length - 1 - level;
    const numerator = this.k * 2 ** depth;
    const denominator = 3 ** depth;
    return Math.max(MIN_LEVEL, Math.floor((numerator + denominator - 1) / denominator));
  }

  private compact(): void {
    for (let l = 0; l < this.levels.length; l++) {
      const level = this.levels[l] as number[];
      if (level.length < this.capacityOf(l)) continue;
      if (l === this.levels.length - 1) this.levels.push([]);
      level.sort((a, b) => a - b);
      const offset = hash32(this.compactions++, (this.seed ^ COIN_SALT) >>> 0) & 1;
      const above = this.levels[l + 1] as number[];
      for (let i = offset; i < level.length - (level.length % 2); i += 2) above.push(level[i] as number);
      this.levels[l] = level.length % 2 === 1 ? [level[level.length - 1] as number] : [];
      return this.compact(); // the level above may now be over capacity
    }
  }

  add(value: number): void {
    if (!Number.isFinite(value)) throw new RangeError("A KLL Sketch takes finite numbers");
    this.added++;
    (this.levels[0] as number[]).push(value);
    this.compact();
  }

  /** The value at a quantile between 0 and 1 (0.5 is the median), or null when nothing was added. */
  quantile(quantile: number): number | null {
    const items = this.items;
    if (items.length === 0) return null;
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    const needed = Math.max(1, Math.ceil(quantile * total - 1e-9));
    let seen = 0;
    for (const item of items) {
      seen += item.weight;
      if (seen >= needed) return item.value;
    }
    return items[items.length - 1]?.value ?? null;
  }

  /** The share of the items at or below a value. */
  rank(value: number): number {
    const items = this.items;
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (total === 0) return 0;
    return items.filter((item) => item.value <= value).reduce((sum, item) => sum + item.weight, 0) / total;
  }

  /** The rank error to expect, as a share of the items: 1.6 / k. */
  get rankError(): number {
    return 1.6 / this.k;
  }

  /** The sketch of both streams: the items of each level together, then compacted. Needs the same k and seed. */
  merge(other: KllSketch): KllSketch {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("KLL sketches merge only with the same k and seed");
    const merged = new KllSketch(this.k, this.seed);
    merged.levels = this.levels.map((level) => [...level]);
    other.levels.forEach((level, l) => {
      while (merged.levels.length <= l) merged.levels.push([]);
      (merged.levels[l] as number[]).push(...level);
    });
    merged.added = this.added + other.added;
    merged.compactions = Math.max(this.compactions, other.compactions);
    merged.compact();
    return merged;
  }
}
