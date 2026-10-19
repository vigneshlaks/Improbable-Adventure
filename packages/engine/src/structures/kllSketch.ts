import { murmur3U32 } from "../hash/murmur3";
import { thinningShift } from "./quantiles";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Json,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** Every level but the top is smaller than the one above it by this factor (KLL's geometric capacities). */
const SHRINK = 2 / 3;
/** The smallest a level can be. */
const MIN_LEVEL = 2;
/** The most levels a sketch plans room for: with k items in the top level that covers streams of k x 2^(LEVELS - 1) units. */
const PLANNED_LEVELS = 24;
/** Mixed into the seed to get the coin a compaction flips. */
const COIN_SALT = 0x6a09e667;

/** The items a sketch with top-level size `k` and `levels` levels can hold: k, then k x 2/3, and so on, none below MIN_LEVEL. */
export function kllCapacity(k: number, levels: number): number {
  let total = 0;
  for (let depth = 0; depth < levels; depth++) total += Math.max(MIN_LEVEL, Math.ceil(k * SHRINK ** depth));
  return total;
}

/**
 * KLL sketch (Karnin, Lang and Liberty): an approximate quantile summary in a few thousand bits. Items are kept in levels; an
 * item at level l stands for 2^l units. When a level is over its capacity it is sorted, every second item (starting from one chosen by
 * a coin) is promoted to the level above, and the rest are dropped: the ranks of the survivors stay right on average, and the
 * error is the same for every quantile (unlike a t-digest, which is sharper at the ends). The higher the level the bigger its
 * capacity, which falls by 2/3 per level going down, so the sketch holds about 3k items however long the stream.
 *
 * It costs VALUE_BITS per stored item, with k as large as fits the Space when planned for `PLANNED_LEVELS` levels. The coin of a
 * compaction is a hash of a counter, not a random generator, so the same stream always makes the same sketch.
 *
 * It cannot delete: it counts the deletes it sees. Deletes remove units at random, so they leave the quantile in place and add
 * noise, which the range allows for as Reservoir Sampling's does.
 */
export class KllSketch implements Structure {
  readonly kind = "kllSketch" as const;
  readonly params: Readonly<Record<string, number>>;

  private levels: number[][] = [[]];
  private insertCount = 0;
  private deleteCount = 0;
  private compactions = 0;
  private readonly k: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("kllSketch", options.spaceBits, constants.valueBits * kllCapacity(2, PLANNED_LEVELS));
    const items = Math.floor(options.spaceBits / constants.valueBits);
    let k = 2;
    while (kllCapacity(k + 1, PLANNED_LEVELS) <= items) k++;
    this.k = k;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.params = { k, capacity: kllCapacity(k, PLANNED_LEVELS) };
  }

  spaceBits(): number {
    return kllCapacity(this.k, PLANNED_LEVELS) * this.constants.valueBits;
  }

  /** Units inserted. */
  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The items now stored, with the number of units each stands for, in ascending order of value. */
  get items(): Array<{ value: number; weight: number }> {
    return this.levels.flatMap((level, l) => level.map((value) => ({ value, weight: 2 ** l }))).sort((a, b) => a.value - b.value);
  }

  private capacityOf(level: number): number {
    return Math.max(MIN_LEVEL, Math.ceil(this.k * SHRINK ** (this.levels.length - 1 - level)));
  }

  private compact(): void {
    for (let l = 0; l < this.levels.length; l++) {
      const level = this.levels[l] as number[];
      if (level.length < this.capacityOf(l)) continue;
      if (l === this.levels.length - 1) this.levels.push([]);
      level.sort((a, b) => a - b);
      const offset = murmur3U32(this.compactions++, (this.seed ^ COIN_SALT) >>> 0) & 1;
      const above = this.levels[l + 1] as number[];
      for (let i = offset; i < level.length - (level.length % 2); i += 2) above.push(level[i] as number);
      this.levels[l] = level.length % 2 === 1 ? [level[level.length - 1] as number] : [];
      return this.compact(); // the level above may now be over capacity (and capacities shift when a level was added)
    }
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++;
      return;
    }
    this.insertCount++;
    (this.levels[0] as number[]).push(event.value);
    this.compact();
  }

  /** The value at a quantile of the units inserted, or null when nothing was inserted. */
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

  /** The rank error to expect, as a share of the units: the coefficient over k. */
  get rankError(): number {
    return this.constants.kllRankError / this.k;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "rank") return null;
    const confidence = this.constants.confidence;
    const estimate = this.quantile(challenge.quantile);
    if (estimate === null) return { estimate: 0, low: 0, high: Number.POSITIVE_INFINITY, confidence };
    const live = Math.max(1, this.insertCount - this.deleteCount);
    const shift = this.rankError + (this.deleteCount === 0 ? 0 : thinningShift(live, challenge.quantile, confidence));
    const low = this.quantile(Math.max(0, challenge.quantile - shift)) as number;
    const high = challenge.quantile + shift >= 1 ? (this.items[this.items.length - 1] as { value: number }).value : (this.quantile(challenge.quantile + shift) as number);
    return { estimate, low: Math.min(low, estimate), high: Math.max(high, estimate), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { levels: this.levels.map((level) => [...level]) as Json, inserts: this.insertCount, deletes: this.deleteCount, compactions: this.compactions },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): KllSketch {
    expectKind(snapshot, "kllSketch");
    const sketch = new KllSketch(optionsFromSnapshot(snapshot), constants);
    const levels = snapshot.state.levels;
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > PLANNED_LEVELS + 1) throw new RangeError('Bad snapshot: "levels" must be a list of levels');
    sketch.levels = levels.map((level) => readCounts({ level }, "level"));
    sketch.insertCount = readNumber(snapshot.state, "inserts");
    sketch.deleteCount = readNumber(snapshot.state, "deletes");
    sketch.compactions = readNumber(snapshot.state, "compactions");
    return sketch;
  }

  clone(): KllSketch {
    const copy = new KllSketch(this.options, this.constants);
    copy.levels = this.levels.map((level) => [...level]);
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    copy.compactions = this.compactions;
    return copy;
  }

  /** The sketch of both streams: the items of each level together, then compacted. Needs the same k and seed. */
  merge(other: Structure): KllSketch {
    if (!(other instanceof KllSketch) || other.k !== this.k || other.seed !== this.seed) throw new Error("KLL sketches merge only with same-sized, same-seeded sketches");
    const merged = this.clone();
    other.levels.forEach((level, l) => {
      while (merged.levels.length <= l) merged.levels.push([]);
      (merged.levels[l] as number[]).push(...level);
    });
    merged.insertCount = this.insertCount + other.insertCount;
    merged.deleteCount = this.deleteCount + other.deleteCount;
    merged.compactions = Math.max(this.compactions, other.compactions);
    merged.compact();
    return merged;
  }
}
