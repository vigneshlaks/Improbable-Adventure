import type { Item } from "./hash.ts";

/**
 * Reservoir Sampling: keeps a uniform random sample of fixed size from a stream of unknown length.
 * Counts and shares are estimated from the sample. Pass your own `random` (returning [0, 1)) for reproducible runs.
 * Size it with `sizeReservoir` in sizing.ts.
 */
export class ReservoirSampling {
  readonly size: number;
  private readonly kept: Item[] = [];
  private seenCount = 0;
  private readonly random: () => number;

  constructor(size: number, random: () => number = Math.random) {
    if (!(size >= 1)) throw new RangeError("A reservoir needs room for at least one item");
    this.size = Math.floor(size);
    this.random = random;
  }

  add(item: Item): void {
    this.seenCount++;
    if (this.kept.length < this.size) {
      this.kept.push(item);
      return;
    }
    const j = Math.floor(this.random() * this.seenCount);
    if (j < this.size) this.kept[j] = item;
  }

  /** How many items have been added. */
  get seen(): number {
    return this.seenCount;
  }

  sample(): Item[] {
    return [...this.kept];
  }

  /** The estimated number of times the item was added: its count in the sample scaled up to the stream. */
  estimateCount(item: Item): number {
    const inSample = this.kept.filter((x) => x === item).length;
    return (inSample * this.seenCount) / Math.max(1, this.kept.length);
  }

  /** The estimated share of the stream that satisfies a test. */
  estimateShare(test: (item: Item) => boolean): number {
    return this.kept.length === 0 ? 0 : this.kept.filter(test).length / this.kept.length;
  }
}
