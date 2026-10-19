import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

/** The bookkeeping bits each slot of a quotient filter carries beside its remainder: occupied, continuation and shifted. */
const METADATA_BITS = 3;

/**
 * Quotient Filter: answers "have I seen this?" like a Bloom Filter, can forget, and merges. It splits a hash into a quotient (q bits),
 * which picks an item's home slot in a table of 2^q slots, and a remainder (r bits), which is what the slot stores. Items with the same
 * quotient form a sorted run and neighbouring runs push each other along; three bookkeeping bits per slot let a run be found again, so a slot
 * costs r + 3 bits and the table 2^q (r + 3).
 *
 * This reference keeps the behaviour and not the packed layout: it holds the multiset of fingerprints (quotient and remainder, q + r bits),
 * one per `add`, up to 2^q of them. A query says yes for an item whose fingerprint it holds, so a never-added item is a false yes with chance
 * about (distinct fingerprints held) / 2^(q + r), the load times 2^-r. `remove` takes away one copy of the fingerprint, exactly. A full table
 * refuses the next `add`. Two filters of the same shape and seed merge. Size it with `sizeQuotient` in sizing.ts.
 */
export class QuotientFilter {
  readonly quotientBits: number;
  readonly remainderBits: number;
  readonly seed: number;
  private readonly fingerprints = new Map<number, number>();
  private entries = 0;

  constructor(quotientBits: number, remainderBits: number, seed = DEFAULT_SEED) {
    if (!Number.isInteger(quotientBits) || quotientBits < 2 || quotientBits > 24) throw new RangeError("The quotient takes 2 to 24 bits");
    if (!Number.isInteger(remainderBits) || remainderBits < 1 || remainderBits > 16 || quotientBits + remainderBits > 32) {
      throw new RangeError("The remainder takes 1 to 16 bits, and the quotient and remainder together at most 32");
    }
    this.quotientBits = quotientBits;
    this.remainderBits = remainderBits;
    this.seed = seed;
  }

  /** The slots in the table, and the memory it takes: each slot is the remainder plus three bookkeeping bits. */
  get slots(): number {
    return 2 ** this.quotientBits;
  }
  get memoryBits(): number {
    return this.slots * (this.remainderBits + METADATA_BITS);
  }
  get size(): number {
    return this.entries;
  }
  get load(): number {
    return this.entries / this.slots;
  }

  private fingerprint(item: Item): number {
    return hash32(item, this.seed) >>> (32 - this.quotientBits - this.remainderBits);
  }

  /** Adds an item. Returns false if the table is full (the item is then not in the filter). */
  add(item: Item): boolean {
    if (this.entries >= this.slots) return false;
    const fp = this.fingerprint(item);
    this.fingerprints.set(fp, (this.fingerprints.get(fp) ?? 0) + 1);
    this.entries++;
    return true;
  }

  /** Removes one copy of an item's fingerprint. Only remove items that were added: removing a stranger can remove a look-alike. */
  remove(item: Item): boolean {
    const fp = this.fingerprint(item);
    const held = this.fingerprints.get(fp) ?? 0;
    if (held === 0) return false;
    if (held === 1) this.fingerprints.delete(fp);
    else this.fingerprints.set(fp, held - 1);
    this.entries--;
    return true;
  }

  /** True if the item may have been added; false means it certainly was not (unless an `add` was refused when the table was full). */
  mightContain(item: Item): boolean {
    return this.fingerprints.has(this.fingerprint(item));
  }

  /** The chance that an item never added is reported: the distinct fingerprints held over all that exist. */
  get falsePositiveRate(): number {
    return Math.min(1, this.fingerprints.size / 2 ** (this.quotientBits + this.remainderBits));
  }

  /** The filter of both streams: every fingerprint of each, as far as the slots go (the first `add` that finds no room is refused). Needs the same shape and seed. */
  merge(other: QuotientFilter): QuotientFilter {
    if (other.quotientBits !== this.quotientBits || other.remainderBits !== this.remainderBits || other.seed !== this.seed) {
      throw new Error("Quotient filters merge only with the same shape and seed");
    }
    const merged = new QuotientFilter(this.quotientBits, this.remainderBits, this.seed);
    for (const source of [this, other]) {
      for (const fp of [...source.fingerprints.keys()].sort((a, b) => a - b)) {
        for (let i = 0; i < (source.fingerprints.get(fp) as number); i++) {
          if (merged.entries >= merged.slots) return merged;
          merged.fingerprints.set(fp, (merged.fingerprints.get(fp) ?? 0) + 1);
          merged.entries++;
        }
      }
    }
    return merged;
  }
}
