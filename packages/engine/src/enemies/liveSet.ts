import type { Rng } from "../rng/rng";

/** Plain-data form of a LiveSet, safe to store as JSON. */
export interface LiveSnapshot {
  /** One entry per live unit: a value inserted three times and never deleted appears three times. */
  items: number[];
  /** Values that were inserted and have since been fully deleted. */
  ghosts: number[];
}

function checkValue(value: unknown, where: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= 2 ** 32) {
    throw new RangeError(`Bad snapshot: "${where}" must hold uint32 values`);
  }
}

/**
 * The exact truth about the stream so far: which values are live, how many times each, and which are ghosts.
 * Challenges are graded against this, never against what the player's structures report.
 */
export class LiveSet {
  private items: number[] = [];
  private counts = new Map<number, number>();
  private ghostSet = new Set<number>();

  static fromSnapshot(snapshot: LiveSnapshot): LiveSet {
    const set = new LiveSet();
    for (const value of snapshot.items) {
      checkValue(value, "items");
      set.items.push(value);
      set.counts.set(value, (set.counts.get(value) ?? 0) + 1);
    }
    for (const value of snapshot.ghosts) {
      checkValue(value, "ghosts");
      if (set.counts.has(value)) throw new RangeError(`Bad snapshot: value ${value} is both live and a ghost`);
      set.ghostSet.add(value);
    }
    return set;
  }

  /** The live set of two streams together: every unit of both, and the values that are ghosts in one and not live in the other. */
  static union(a: LiveSet, b: LiveSet): LiveSet {
    const set = new LiveSet();
    set.items = [...a.items, ...b.items];
    for (const item of set.items) set.counts.set(item, (set.counts.get(item) ?? 0) + 1);
    for (const ghost of [...a.ghostSet, ...b.ghostSet]) if (!set.counts.has(ghost)) set.ghostSet.add(ghost);
    return set;
  }

  snapshot(): LiveSnapshot {
    return { items: [...this.items], ghosts: [...this.ghostSet] };
  }

  insert(value: number): void {
    this.items.push(value);
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    this.ghostSet.delete(value);
  }

  /** Removes one live unit chosen uniformly at random, so a value is deleted in proportion to how much of it is live. */
  deleteRandom(rng: Rng): number | null {
    if (this.items.length === 0) return null;
    const index = rng.int(this.items.length);
    const value = this.items[index] as number;
    const last = this.items.pop() as number;
    if (index < this.items.length) this.items[index] = last;

    const remaining = (this.counts.get(value) ?? 0) - 1;
    if (remaining > 0) {
      this.counts.set(value, remaining);
    } else {
      this.counts.delete(value);
      this.ghostSet.add(value);
    }
    return value;
  }

  count(value: number): number {
    return this.counts.get(value) ?? 0;
  }

  get liveTotal(): number {
    return this.items.length;
  }

  /** Number of distinct live values. */
  get distinct(): number {
    return this.counts.size;
  }

  /** The heaviest live value and its count. Ties go to the lowest value. Null when nothing is live. */
  mode(): { value: number; count: number } | null {
    let best: { value: number; count: number } | null = null;
    for (const [value, count] of this.counts) {
      if (best === null || count > best.count || (count === best.count && value < best.value)) best = { value, count };
    }
    return best;
  }

  /** The share of live units whose value is at most `value`: its rank, from 0 to 1. With nothing live it is 0. */
  rankOf(value: number): number {
    if (this.items.length === 0) return 0;
    let atMost = 0;
    for (const item of this.items) if (item <= value) atMost++;
    return atMost / this.items.length;
  }

  /** The smallest live value whose rank reaches `quantile` (a number from 0 to 1), or null with nothing live. */
  quantileValue(quantile: number): number | null {
    if (this.items.length === 0) return null;
    const sorted = [...this.items].sort((a, b) => a - b);
    const needed = Math.max(1, Math.ceil(quantile * sorted.length - 1e-9)); // how many units must lie at or below it
    return sorted[needed - 1] as number;
  }

  /** Live values in ascending order. */
  liveValues(): number[] {
    return [...this.counts.keys()].sort((a, b) => a - b);
  }

  ghosts(): number[] {
    return [...this.ghostSet];
  }
}
