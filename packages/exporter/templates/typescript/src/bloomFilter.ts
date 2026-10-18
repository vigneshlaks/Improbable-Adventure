import { DEFAULT_SEED, positions, type Item } from "./hash.ts";

/**
 * Bloom Filter: answers "have I seen this?" in a fixed number of bits.
 * It never says no for something that was added, and sometimes says yes for something that was not (a false positive).
 * It cannot remove items. Size it with `sizeBloom` in sizing.ts.
 */
export class BloomFilter {
  readonly bits: number;
  readonly hashes: number;
  readonly seed: number;
  private readonly words: Uint32Array;
  private setBits = 0;

  constructor(bits: number, hashes: number, seed = DEFAULT_SEED) {
    if (!(bits >= 1) || !(hashes >= 1)) throw new RangeError("A Bloom Filter needs at least one bit and one hash");
    this.bits = Math.floor(bits);
    this.hashes = Math.floor(hashes);
    this.seed = seed;
    this.words = new Uint32Array(Math.ceil(this.bits / 32));
  }

  add(item: Item): void {
    for (const index of positions(item, this.hashes, this.bits, this.seed)) {
      const word = index >>> 5;
      const mask = 1 << (index & 31);
      if (((this.words[word] as number) & mask) === 0) {
        this.words[word] = (this.words[word] as number) | mask;
        this.setBits++;
      }
    }
  }

  /** False means certainly never added. True means probably added. */
  mightContain(item: Item): boolean {
    return positions(item, this.hashes, this.bits, this.seed).every((index) => ((this.words[index >>> 5] as number) & (1 << (index & 31))) !== 0);
  }

  /** The share of bits that are set. */
  get fill(): number {
    return this.setBits / this.bits;
  }

  /** The false-positive rate right now, from how full the filter is. */
  falsePositiveRate(): number {
    return this.fill ** this.hashes;
  }
}
