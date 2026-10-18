import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";
import { registerAndRank, REGISTER_BITS } from "./registers.ts";

const ALPHA_INFINITY = 0.39701;

/**
 * LogLog: the simpler ancestor of HyperLogLog. It averages the registers' ranks instead of their reciprocals,
 * so it needs about 1.3 / error^2 registers where HyperLogLog needs 1.04 / error^2. Prefer HyperLogLog unless you
 * need the simpler arithmetic. Size it with `sizeLogLog`.
 */
export class LogLog {
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

  /** Only sound once the stream has many more different items than registers. */
  estimate(): number {
    const m = this.size;
    let sum = 0;
    for (const r of this.registers) sum += r;
    const alpha = ALPHA_INFINITY - (2 * Math.PI * Math.PI + Math.LN2 * Math.LN2) / (48 * m);
    return alpha * m * 2 ** (sum / m);
  }

  /** The expected relative standard error: 1.3 / sqrt(registers). */
  get standardError(): number {
    return 1.3 / Math.sqrt(this.size);
  }

  /** Bits one register takes. */
  static readonly registerBits = REGISTER_BITS;
}
