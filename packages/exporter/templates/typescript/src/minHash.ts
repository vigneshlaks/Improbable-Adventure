import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

const EMPTY = 2 ** 32;
/** Spaces out the seeds of the slots' hash functions. */
const SLOT_SALT = 0x9e3779b1;

/**
 * MinHash: estimates how alike two sets are (their Jaccard similarity: shared items over items in either) from a short signature.
 * For each of k hash functions it keeps the smallest hash of any item added. Two sets agree on that minimum with exactly the chance of
 * their similarity, so the share of slots where two signatures agree estimates it, with a standard error of at most 1 / (2 sqrt(k)).
 * Adding an item again changes nothing, nothing can be removed, and the signature of two sets together is the smaller minimum in every slot.
 * Both signatures must have the same k and seed. Size it with `sizeMinHash` in sizing.ts.
 */
export class MinHash {
  readonly k: number;
  readonly seed: number;
  private minima: number[];

  constructor(k: number, seed = DEFAULT_SEED) {
    if (!(k >= 1)) throw new RangeError("A MinHash needs at least one slot");
    this.k = Math.floor(k);
    this.seed = seed;
    this.minima = new Array<number>(this.k).fill(EMPTY);
  }

  private slotSeed(i: number): number {
    return (this.seed + Math.imul(i + 1, SLOT_SALT)) >>> 0;
  }

  /** The smallest hash seen by each slot (2^32 for a slot that has seen nothing). */
  get signature(): readonly number[] {
    return this.minima;
  }

  add(item: Item): void {
    for (let i = 0; i < this.k; i++) {
      const hash = hash32(item, this.slotSeed(i));
      if (hash < (this.minima[i] as number)) this.minima[i] = hash;
    }
  }

  /** The estimated Jaccard similarity to another MinHash: the share of slots whose minima agree. */
  similarity(other: MinHash): number {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("MinHashes compare only with the same k and seed");
    let agree = 0;
    for (let i = 0; i < this.k; i++) if (this.minima[i] === other.minima[i] && this.minima[i] !== EMPTY) agree++;
    return agree / this.k;
  }

  /** The MinHash of both sets together. */
  merge(other: MinHash): MinHash {
    if (other.k !== this.k || other.seed !== this.seed) throw new Error("MinHashes merge only with the same k and seed");
    const merged = new MinHash(this.k, this.seed);
    for (let i = 0; i < this.k; i++) merged.minima[i] = Math.min(this.minima[i] as number, other.minima[i] as number);
    return merged;
  }

  /** The most the estimate is likely to be off, at one standard error: 1 / (2 sqrt(k)). */
  get standardError(): number {
    return 1 / (2 * Math.sqrt(this.k));
  }
}
