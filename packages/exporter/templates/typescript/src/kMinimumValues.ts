import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

const HASH_RANGE = 2 ** 32;

/**
 * K-Minimum Values: counts different items by keeping only the k smallest hashes of the items seen. While it has seen fewer than k
 * different items it counts them exactly. Past that, the k-th smallest hash, as a share u of the hash range, says how crowded the items are:
 * with n different items the k smallest hashes fill about k / n of the range, so the estimate is (k - 1) / u, with a relative standard
 * error of about 1 / sqrt(k - 2). Adding an item again changes nothing, nothing can be removed, and two sketches of the same size and seed
 * merge into the sketch of both streams. Size it with `sizeKmv` in sizing.ts.
 */
export class KMinimumValues {
  readonly k: number;
  readonly seed: number;
  private sorted: number[] = [];

  constructor(k: number, seed = DEFAULT_SEED) {
    if (!(k >= 3)) throw new RangeError("K-Minimum Values needs k of at least 3");
    this.k = Math.floor(k);
    this.seed = seed;
  }

  /** The kept hashes, smallest first. */
  get hashes(): readonly number[] {
    return this.sorted;
  }

  add(item: Item): void {
    const hash = hash32(item, this.seed);
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.sorted[mid] as number) < hash) low = mid + 1;
      else high = mid;
    }
    if (this.sorted[low] === hash) return; // an item already kept
    if (this.sorted.length < this.k) this.sorted.splice(low, 0, hash);
    else if (low < this.k) {
      this.sorted.splice(low, 0, hash);
      this.sorted.pop();
    }
  }

  /** The estimated number of different items. */
  count(): number {
    if (this.sorted.length < this.k) return this.sorted.length;
    return (this.k - 1) / ((this.sorted[this.k - 1] as number) / HASH_RANGE);
  }

  /** The relative standard error of `count`: 0 while it holds every different item, otherwise 1 / sqrt(k - 2). */
  get standardError(): number {
    return this.sorted.length < this.k ? 0 : 1 / Math.sqrt(this.k - 2);
  }

  /** The sketch of both streams: the k smallest hashes of both. Needs the same k and seed. */
  merge(other: KMinimumValues): KMinimumValues {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("Sketches merge only with the same k and seed");
    const merged = new KMinimumValues(this.k, this.seed);
    merged.sorted = [...new Set([...this.sorted, ...other.sorted])].sort((a, b) => a - b).slice(0, this.k);
    return merged;
  }
}
