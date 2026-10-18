import type { Item } from "./hash.ts";

/**
 * Exact Memory: a table of every distinct item and its count. No error at all, and memory grows with the number
 * of different items. Use it when that is affordable, and as the truth to test the other structures against.
 */
export class ExactMemory {
  private readonly counts = new Map<Item, number>();
  private totalCount = 0;

  add(item: Item, count = 1): void {
    this.counts.set(item, (this.counts.get(item) ?? 0) + count);
    this.totalCount += count;
  }

  remove(item: Item, count = 1): void {
    const have = this.counts.get(item) ?? 0;
    const taken = Math.min(have, count);
    if (taken === have) this.counts.delete(item);
    else this.counts.set(item, have - taken);
    this.totalCount -= taken;
  }

  count(item: Item): number {
    return this.counts.get(item) ?? 0;
  }

  /** The number of different items. */
  get distinct(): number {
    return this.counts.size;
  }

  /** The number of items, counting repeats. */
  get total(): number {
    return this.totalCount;
  }
}
