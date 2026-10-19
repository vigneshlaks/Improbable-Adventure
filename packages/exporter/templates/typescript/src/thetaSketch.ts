import { KMinimumValues } from "./kMinimumValues.ts";
import { DEFAULT_SEED, type Item } from "./hash.ts";

const HASH_RANGE = 2 ** 32;

/**
 * Theta Sketch (Dasgupta and others; Apache DataSketches): K-Minimum Values built for set arithmetic. It keeps the k smallest hashes of the different items
 * added; the largest of them, as a share of the hash range, is theta, and every item whose hash is below theta is in the sketch, so the sketch is a sample
 * of the items at rate theta. That sample gives the count (the number of hashes over theta), and two sketches give the count of the union (take the k smallest
 * hashes of both) and of the intersection (the hashes both hold below the smaller theta, over that theta), with an error of about 1 / sqrt(k - 2) of the
 * union. Adding an item again changes nothing, and nothing can be removed. Size it with `sizeKmv` in sizing.ts (it is the same size).
 */
export class ThetaSketch {
  readonly k: number;
  readonly seed: number;
  private inner: KMinimumValues;

  constructor(k: number, seed = DEFAULT_SEED) {
    this.k = k;
    this.seed = seed;
    this.inner = new KMinimumValues(k, seed);
  }

  /** The kept hashes, smallest first. */
  get hashes(): readonly number[] {
    return this.inner.hashes;
  }

  /** Theta: the share of the hash range below which every item is in the sketch (1 while it holds every different item it has seen). */
  get theta(): number {
    return this.inner.hashes.length < this.k ? 1 : (this.inner.hashes[this.k - 1] as number) / HASH_RANGE;
  }

  add(item: Item): void {
    this.inner.add(item);
  }

  /** The estimated number of different items. */
  count(): number {
    return this.inner.count();
  }

  /** The relative standard error of `count`. */
  get standardError(): number {
    return this.inner.standardError;
  }

  /** The sketch of both streams. Needs the same k and seed. */
  union(other: ThetaSketch): ThetaSketch {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("Theta sketches combine only with the same k and seed");
    const merged = new ThetaSketch(this.k, this.seed);
    merged.inner = this.inner.merge(other.inner);
    return merged;
  }

  /** The estimated number of items in both streams: the hashes both sketches hold below the smaller theta, over that theta. */
  intersectionCount(other: ThetaSketch): number {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("Theta sketches combine only with the same k and seed");
    const theta = Math.min(this.theta, other.theta);
    const mine = new Set(this.inner.hashes);
    let shared = 0;
    for (const hash of other.inner.hashes) if (mine.has(hash) && hash / HASH_RANGE < theta) shared++;
    return theta === 1 ? shared : shared / theta;
  }
}
