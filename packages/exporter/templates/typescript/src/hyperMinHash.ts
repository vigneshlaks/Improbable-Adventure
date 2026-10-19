import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

/** Bits of the position of the first one bit in a register. */
const RANK_BITS = 5;
/** Starts the synthetic items that measure how often unrelated registers agree. */
const REFERENCE_BASE = 3_500_000_000;
/** HyperLogLog's bias correction for the harmonic mean. */
const alpha = (m: number): number => (m >= 128 ? 0.7213 / (1 + 1.079 / m) : m >= 64 ? 0.709 : m >= 32 ? 0.697 : 0.673);

/**
 * HyperMinHash (Yu and Weber): MinHash laid out like a HyperLogLog. A hash is cut into a bucket (the first `indexBits` bits), the position of the first one
 * bit among the rest (as in HyperLogLog) and the `mantissaBits` bits after that one; a register keeps the smallest hash of its bucket in that coded form,
 * 5 + mantissaBits bits. So there are 2^indexBits registers of 8 bits (against MinHash's 32-bit slots, about four times as many for the same memory), an
 * add touches one register, and the same registers count the different items, as a HyperLogLog does.
 *
 * Two sets agree in a bucket when the smallest hash of their union is in both, which has the chance of their Jaccard similarity, or when two different smallest
 * hashes happen to have the same code, which has a chance p that `similarityTo` measures: it builds a synthetic set of the other set's size from items nobody
 * uses and counts how often its registers agree with these. Then (agreeing buckets / buckets either set uses - p) / (1 - p) estimates the similarity. Items
 * cannot be removed. Size it with `sizeHyperMinHash` in sizing.ts.
 */
export class HyperMinHash {
  readonly indexBits: number;
  readonly mantissaBits: number;
  readonly seed: number;
  private registers: Uint16Array;

  constructor(indexBits: number, seed = DEFAULT_SEED, mantissaBits = 3) {
    if (!Number.isInteger(indexBits) || indexBits < 4 || indexBits > 20) throw new RangeError("A HyperMinHash takes 4 to 20 index bits");
    if (!Number.isInteger(mantissaBits) || mantissaBits < 1 || mantissaBits > 8) throw new RangeError("The mantissa takes 1 to 8 bits");
    this.indexBits = indexBits;
    this.mantissaBits = mantissaBits;
    this.seed = seed;
    this.registers = new Uint16Array(2 ** indexBits);
  }

  /** The number of registers, and the memory they take. */
  get size(): number {
    return 2 ** this.indexBits;
  }
  get memoryBits(): number {
    return this.size * (RANK_BITS + this.mantissaBits);
  }

  /** The bucket of an item and the code of its hash: the position and mantissa, arranged so that a larger code is a smaller hash. 0 is an empty register. */
  private place(item: Item): { bucket: number; code: number } {
    const h = hash32(item, this.seed);
    const bucket = h >>> (32 - this.indexBits);
    const rest = (h << this.indexBits) >>> 0;
    const rank = Math.min(2 ** RANK_BITS - 1, rest === 0 ? 33 - this.indexBits : Math.clz32(rest) + 1);
    const mantissa = rest === 0 || rank >= 32 ? 0 : ((rest << rank) >>> (32 - this.mantissaBits)) & (2 ** this.mantissaBits - 1);
    return { bucket, code: rank * 2 ** this.mantissaBits + (2 ** this.mantissaBits - 1 - mantissa) + 1 };
  }

  add(item: Item): void {
    const { bucket, code } = this.place(item);
    if (code > (this.registers[bucket] as number)) this.registers[bucket] = code;
  }

  /** The registers of a set of items, made with this sketch's hash. */
  registersOf(items: readonly Item[]): Uint16Array {
    const out = new Uint16Array(this.size);
    for (const item of items) {
      const { bucket, code } = this.place(item);
      if (code > (out[bucket] as number)) out[bucket] = code;
    }
    return out;
  }

  /** The buckets either side uses and the buckets where both agree. */
  private compare(other: Uint16Array): { used: number; agree: number } {
    let used = 0;
    let agree = 0;
    for (let i = 0; i < this.size; i++) {
      const mine = this.registers[i] as number;
      const theirs = other[i] as number;
      if (mine === 0 && theirs === 0) continue;
      used++;
      if (mine === theirs) agree++;
    }
    return { used, agree };
  }

  /** The estimated number of different items, as a HyperLogLog counts them from the position part of the registers (standard error about 1.04 / sqrt(registers)). */
  cardinality(): number {
    let sum = 0;
    let empty = 0;
    for (const code of this.registers) {
      if (code === 0) {
        empty++;
        sum += 1;
      } else sum += 2 ** -Math.floor((code - 1) / 2 ** this.mantissaBits);
    }
    const estimate = (alpha(this.size) * this.size * this.size) / sum;
    return estimate <= 2.5 * this.size && empty > 0 ? this.size * Math.log(this.size / empty) : estimate;
  }

  /** The estimated Jaccard similarity of a set of items to the items added, with the agreement by chance taken out, and the numbers it was worked out from. */
  similarityTo(items: readonly Item[]): { similarity: number; collision: number; agreeShare: number; used: number } {
    const distinct = new Set(items.map((item) => (typeof item === "object" ? `b${Array.from(item).join(",")}` : `${typeof item}${item}`)));
    const { used, agree } = this.compare(this.registersOf(items));
    const reference = this.registersOf(Array.from({ length: Math.max(1, distinct.size) }, (_, i) => REFERENCE_BASE + i));
    const { used: refUsed, agree: refAgree } = this.compare(reference);
    const collision = refUsed === 0 ? 0 : refAgree / refUsed;
    const agreeShare = used === 0 ? 0 : agree / used;
    return { similarity: Math.max(0, Math.min(1, (agreeShare - collision) / (1 - collision))), collision, agreeShare, used };
  }

  /** The most the estimate is likely to be off, at one standard error: about 1 / (2 sqrt(registers)), a little more after the correction for chance agreements. */
  get standardError(): number {
    return 1 / (2 * Math.sqrt(this.size));
  }

  /** The sketch of both sets together: the smaller hash in every bucket. Needs the same index bits, mantissa bits and seed. */
  merge(other: HyperMinHash): HyperMinHash {
    if (other.indexBits !== this.indexBits || other.mantissaBits !== this.mantissaBits || other.seed !== this.seed) throw new Error("HyperMinHashes merge only with the same shape and seed");
    const merged = new HyperMinHash(this.indexBits, this.seed, this.mantissaBits);
    for (let i = 0; i < this.size; i++) merged.registers[i] = Math.max(this.registers[i] as number, other.registers[i] as number);
    return merged;
  }
}
