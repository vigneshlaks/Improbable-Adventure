import { DEFAULT_SEED, positions, type Item } from "./hash.ts";

/**
 * Spectral Bloom Filter: a Bloom Filter made of counters, so one structure answers "have I seen this?" and "how many times?", and items can be
 * removed. An item adds one to each of its k counters; it may have been added if all of them are above zero, and its count is the smallest of
 * them, which is never below the truth (the same guarantee as a Count-Min Sketch). All k counters share one array. A counter that reaches its top
 * stops and is no longer reliable: it says "at least", and removals leave it alone. Size it with `sizeSpectral` in sizing.ts.
 */
export class SpectralBloom {
  readonly counters: number;
  readonly hashes: number;
  readonly seed: number;
  readonly counterBits: number;
  private readonly cells: Uint32Array;
  private readonly max: number;
  private total = 0;

  constructor(counters: number, hashes: number, seed = DEFAULT_SEED, counterBits = 16) {
    if (!(counters >= 1) || !(hashes >= 1)) throw new RangeError("A Spectral Bloom Filter needs at least one counter and one hash");
    if (!Number.isInteger(counterBits) || counterBits < 2 || counterBits > 32) throw new RangeError("A counter takes 2 to 32 bits");
    this.counters = Math.floor(counters);
    this.hashes = Math.floor(hashes);
    this.seed = seed;
    this.counterBits = counterBits;
    this.max = counterBits === 32 ? 0xffffffff : 2 ** counterBits - 1;
    this.cells = new Uint32Array(this.counters);
  }

  /** The memory it takes. */
  get memoryBits(): number {
    return this.counters * this.counterBits;
  }

  /** Items added minus items removed. */
  get liveTotal(): number {
    return this.total;
  }

  add(item: Item, count = 1): void {
    for (const index of positions(item, this.hashes, this.counters, this.seed)) {
      this.cells[index] = Math.min(this.max, (this.cells[index] as number) + count);
    }
    this.total += count;
  }

  /** Takes back `count` earlier additions. Exact for items that were added; a counter that has stopped is left alone. */
  remove(item: Item, count = 1): void {
    for (const index of positions(item, this.hashes, this.counters, this.seed)) {
      const c = this.cells[index] as number;
      if (c > 0 && c < this.max) this.cells[index] = Math.max(0, c - count);
    }
    this.total = Math.max(0, this.total - count);
  }

  /** At least the true count, and usually close to it; a count at the counters' top means "at least this". */
  estimate(item: Item): number {
    let best = this.max;
    for (const index of positions(item, this.hashes, this.counters, this.seed)) best = Math.min(best, this.cells[index] as number);
    return best;
  }

  /** False means certainly not added (the smallest counter is zero). True means probably added. */
  mightContain(item: Item): boolean {
    return this.estimate(item) > 0;
  }

  /** How far a count is likely to overshoot: the counters share one array, so an item's counter holds about k N / m units of others; the band is e times that. */
  get overshoot(): number {
    return (Math.E * this.hashes * this.total) / this.counters;
  }

  /** The false-positive rate right now, from the share of counters in use. */
  get falsePositiveRate(): number {
    let used = 0;
    for (const c of this.cells) if (c > 0) used++;
    return (used / this.counters) ** this.hashes;
  }
}
