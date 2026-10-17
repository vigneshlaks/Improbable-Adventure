import { doubleHashIndices } from "../hash/doubleHash";
import { murmur3U32 } from "../hash/murmur3";
import { binomialUpper } from "../stats/stats";
import { bloomOptimalK } from "./bloomFilter";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** Fewest cells that still behave like a filter. */
const MIN_CELLS = 16;

/** Gives the cells chosen for decay a hash stream independent of the values' own positions. */
const DECAY_SALT = 0x0decaf00;

/**
 * Cells decremented per insert so that the filter settles to the fullness of a Bloom Filter loaded with `items` values
 * (Deng and Rafiei's stable point): with Z = e^(-k items / cells), P = 1 / ((Z^(-1/max) - 1)(1/k - 1/cells)). Never fewer
 * than one, and never more than there are cells.
 */
export function stableDecrements(cells: number, k: number, items: number, max: number): number {
  const zeroShare = Math.exp((-k * items) / cells);
  const slope = Math.pow(zeroShare, -1 / max) - 1;
  const rate = 1 / (slope * (1 / k - 1 / cells));
  return Math.min(cells, Math.max(1, Math.round(rate)));
}

/**
 * The chance a value inserted `inserts` inserts ago has been forgotten. A value is flagged only while all k of its cells are
 * above zero, so it is forgotten as soon as any one of them has decayed to zero: 1 - (1 - p)^k, where p is the chance one cell
 * is gone. Each later insert decrements `perInsert` cells, so a given cell loses Binomial(inserts x perInsert, 1/cells)
 * counts and is gone once it has lost `max`. Other values re-setting a cell only help it survive, so this is an upper bound.
 */
export function forgetProbability(inserts: number, perInsert: number, cells: number, max: number, k: number): number {
  const trials = inserts * perInsert;
  if (trials <= 0) return 0;
  const p = 1 / cells;
  let term = Math.exp(trials * Math.log1p(-p)); // chance of 0 decrements
  let below = term;
  for (let j = 0; j < max - 1; j++) {
    term *= ((trials - j) / (j + 1)) * (p / (1 - p));
    below += term;
  }
  const cellGone = Math.min(1, Math.max(0, 1 - below));
  return 1 - Math.pow(1 - cellGone, k);
}

/**
 * Stable Bloom Filter: a Bloom Filter with the Fading enchantment. Cells are small counters. An insert first decrements a
 * few pseudo-random cells, then sets the value's k cells to the maximum, so what was inserted long ago fades. The filter
 * never fills up, at the price of false negatives. It cannot delete, so deletes are only counted (a deleted value fades like
 * any other). Its Presence range allows for false positives, ghosts and forgotten values.
 */
export class StableBloomFilter implements Structure {
  readonly kind = "bloomFilter" as const;
  readonly params: Readonly<Record<string, number>>;

  private cellValues: Uint8Array;
  private nonZero = 0;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly cells: number;
  private readonly k: number;
  private readonly max: number;
  private readonly decrements: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    const bits = constants.fadingCellBits;
    assertSpace("bloomFilter", options.spaceBits, bits * MIN_CELLS);
    this.cells = Math.floor(options.spaceBits / bits);
    this.max = 2 ** bits - 1;
    const items = Math.max(1, Math.floor(options.knob ?? this.cells * constants.fadingWindow));
    this.k = bloomOptimalK(this.cells, items);
    this.decrements = stableDecrements(this.cells, this.k, items, this.max);
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.cellValues = new Uint8Array(this.cells);
    this.params = { cells: this.cells, k: this.k, expectedItems: items, decrements: this.decrements, cellMax: this.max };
  }

  spaceBits(): number {
    return this.constants.fadingCellBits * this.cells;
  }

  /** Share of cells that are not zero. */
  get fill(): number {
    return this.nonZero / this.cells;
  }

  /** Insert events seen. */
  get inserts(): number {
    return this.insertCount;
  }

  /** Delete events seen and ignored (the deleted value fades like any other). */
  get deletes(): number {
    return this.deleteCount;
  }

  private test(value: number): boolean {
    return doubleHashIndices(value, this.k, this.cells, this.seed).every((index) => (this.cellValues[index] ?? 0) > 0);
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++;
      return;
    }
    for (let j = 0; j < this.decrements; j++) {
      const index = murmur3U32((this.insertCount * this.decrements + j) >>> 0, (this.seed ^ DECAY_SALT) >>> 0) % this.cells;
      const current = this.cellValues[index] ?? 0;
      if (current > 0) {
        this.cellValues[index] = current - 1;
        if (current === 1) this.nonZero--;
      }
    }
    for (const index of doubleHashIndices(event.value, this.k, this.cells, this.seed)) {
      if ((this.cellValues[index] ?? 0) === 0) this.nonZero++;
      this.cellValues[index] = this.max;
    }
    this.insertCount++;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "presence") return null;
    const flagged = challenge.targets.filter((target) => this.test(target));
    // The chance of a miss is shared between the two sides of the range.
    const side = 1 - (1 - this.constants.confidence) / 2;
    const maxFalse = binomialUpper(challenge.targets.length, Math.pow(this.fill, this.k), side);
    const ghosts = Math.min(this.deleteCount, flagged.length);
    const forgotten = forgetProbability(this.insertCount, this.decrements, this.cells, this.max, this.k);
    const maxMissed = forgotten === 0 ? 0 : binomialUpper(challenge.targets.length, forgotten, side);
    return {
      estimate: flagged,
      low: Math.max(0, flagged.length - maxFalse - ghosts),
      high: Math.min(challenge.targets.length, flagged.length + maxMissed),
      confidence: this.constants.confidence,
    };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { cells: Array.from(this.cellValues), inserts: this.insertCount, deletes: this.deleteCount },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): StableBloomFilter {
    expectKind(snapshot, "bloomFilter");
    const filter = new StableBloomFilter(optionsFromSnapshot(snapshot), constants);
    filter.cellValues = Uint8Array.from(readCounts(snapshot.state, "cells", filter.cells));
    filter.nonZero = filter.cellValues.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
    filter.insertCount = readNumber(snapshot.state, "inserts");
    filter.deleteCount = readNumber(snapshot.state, "deletes");
    return filter;
  }

  clone(): StableBloomFilter {
    const copy = new StableBloomFilter(this.options, this.constants);
    copy.cellValues = new Uint8Array(this.cellValues);
    copy.nonZero = this.nonZero;
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }

  /** The larger counter of each cell: a value kept fresh in either filter stays flagged. */
  merge(other: Structure): StableBloomFilter {
    if (!(other instanceof StableBloomFilter) || other.cells !== this.cells || other.k !== this.k || other.seed !== this.seed) {
      throw new Error("Stable Bloom filters merge only with same-shaped, same-seeded ones");
    }
    const merged = this.clone();
    let nonZero = 0;
    for (let i = 0; i < merged.cellValues.length; i++) {
      const value = Math.max(merged.cellValues[i] ?? 0, other.cellValues[i] ?? 0);
      merged.cellValues[i] = value;
      if (value > 0) nonZero++;
    }
    merged.nonZero = nonZero;
    merged.insertCount = this.insertCount + other.insertCount;
    merged.deleteCount = this.deleteCount + other.deleteCount;
    return merged;
  }
}
