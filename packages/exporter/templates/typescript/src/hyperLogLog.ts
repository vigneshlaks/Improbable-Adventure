import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";
import { registerAndRank } from "./registers.ts";

/** Below this many times the register count, counting empty registers is more accurate than the harmonic mean. */
const SMALL_RANGE = 2.8;

function alpha(m: number): number {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

/**
 * HyperLogLog: estimates how many different items were added, using 2^indexBits small registers.
 * Standard error is about 1.04 / sqrt(registers). Memory does not grow with the stream. Size it with `sizeHyperLogLog`.
 * Items are hashed to 32 bits, so counts beyond a few hundred million lose accuracy.
 */
export class HyperLogLog {
  readonly indexBits: number;
  readonly registers: Uint8Array;
  readonly seed: number;

  constructor(indexBits: number, seed = DEFAULT_SEED) {
    if (!Number.isInteger(indexBits) || indexBits < 4 || indexBits > 20) throw new RangeError("indexBits must be a whole number from 4 to 20");
    this.indexBits = indexBits;
    this.seed = seed;
    this.registers = new Uint8Array(2 ** indexBits);
  }

  get size(): number {
    return this.registers.length;
  }

  add(item: Item): void {
    const { index, rank } = registerAndRank(hash32(item, this.seed), this.indexBits);
    if (rank > (this.registers[index] as number)) this.registers[index] = rank;
  }

  estimate(): number {
    const m = this.size;
    let sum = 0;
    let empty = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;
      if (r === 0) empty++;
    }
    if (empty > 0 && m * Math.log(m / empty) <= SMALL_RANGE * m) return m * Math.log(m / empty); // small stream: count empty registers
    return (alpha(m) * m * m) / sum;
  }

  /** The expected relative standard error: 1.04 / sqrt(registers). */
  get standardError(): number {
    return 1.04 / Math.sqrt(this.size);
  }

  /** Combines another counter of the same size and seed, as if it had seen both streams. */
  merge(other: HyperLogLog): void {
    if (other.indexBits !== this.indexBits || other.seed !== this.seed) throw new RangeError("Only counters of the same size and seed can merge");
    other.registers.forEach((r, i) => {
      if (r > (this.registers[i] as number)) this.registers[i] = r;
    });
  }
}
