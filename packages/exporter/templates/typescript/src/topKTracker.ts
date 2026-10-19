import { CountMinSketch } from "./countMinSketch.ts";
import { DEFAULT_SEED, type Item } from "./hash.ts";

interface Candidate {
  item: Item;
  /** The count is at least `low` and at most `high`. */
  low: number;
  high: number;
}

/** A key that is the same for equal items. */
const keyOf = (item: Item): string => (typeof item === "object" ? `b${Array.from(item).join(",")}` : `${typeof item}${item}`);

/**
 * Top-K Tracker: finds the heaviest items of a stream (heavy hitters) and keeps a tight interval around each one's count. A Count-Min Sketch ranks
 * the items; a short list of `capacity` candidates keeps, for each, a lower and an upper bound on its count. An item joins the list when its sketch estimate
 * beats the weakest candidate's upper bound (or the list is not full), with the interval the sketch gives at that moment: its estimate is an upper bound
 * (the sketch never underestimates), and the estimate less the sketch's error band is a lower bound that holds with the sketch's confidence. After that every
 * addition raises both ends by one and every removal lowers both, so an item that entered early, while the stream was small and the band narrow, keeps a
 * narrow interval however big the stream grows. A heavy item enters early, so on a skewed stream the heavy items are answered far more tightly than the plain
 * sketch could, and an item not on the list is answered by the sketch. Size it with `sizeTopK` in sizing.ts.
 */
export class TopKTracker {
  readonly capacity: number;
  private readonly grid: CountMinSketch;
  private entries: Candidate[] = [];

  constructor(width: number, depth: number, capacity: number, seed = DEFAULT_SEED) {
    if (!(capacity >= 1)) throw new RangeError("A Top-K Tracker needs room for at least one candidate");
    this.capacity = Math.floor(capacity);
    this.grid = new CountMinSketch(width, depth, seed);
  }

  private find(item: Item): Candidate | undefined {
    const key = keyOf(item);
    return this.entries.find((entry) => keyOf(entry.item) === key);
  }

  add(item: Item): void {
    this.grid.add(item);
    const entry = this.find(item);
    if (entry) {
      entry.low += 1;
      entry.high += 1;
      return;
    }
    const high = this.grid.estimate(item);
    const low = Math.min(high, Math.max(1, Math.floor(high - this.grid.overshoot))); // it was just added, so at least one is live; rounded down, so still a bound
    if (this.entries.length < this.capacity) {
      this.entries.push({ item, low, high });
      return;
    }
    let weakest = this.entries[0] as Candidate;
    for (const candidate of this.entries) if (candidate.high < weakest.high) weakest = candidate;
    if (high > weakest.high) this.entries[this.entries.indexOf(weakest)] = { item, low, high };
  }

  /** Takes back an earlier addition. Only remove items that were added. */
  remove(item: Item): void {
    this.grid.remove(item);
    const entry = this.find(item);
    if (!entry) return;
    entry.low = Math.max(0, entry.low - 1);
    entry.high = Math.max(0, entry.high - 1);
    if (entry.high === 0) this.entries = this.entries.filter((candidate) => candidate !== entry); // nothing of it is left: free the place
  }

  /** The count of an item as an interval: tight for an item on the list, the sketch's (never below the truth) for the rest. */
  estimate(item: Item): { low: number; high: number } {
    const entry = this.find(item);
    if (entry) return { low: entry.low, high: entry.high };
    const high = this.grid.estimate(item);
    return { low: Math.max(0, high - this.grid.overshoot), high };
  }

  /** The candidates, heaviest first. */
  heavyHitters(): Array<{ item: Item; low: number; high: number }> {
    return [...this.entries].sort((a, b) => b.high + b.low - (a.high + a.low)).map((entry) => ({ ...entry }));
  }
}
