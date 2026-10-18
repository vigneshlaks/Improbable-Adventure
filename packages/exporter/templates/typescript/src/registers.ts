// What HyperLogLog and LogLog share: five-bit registers, each holding the longest run of leading zeros seen.

/** Bits in one register; a register holds a rank from 0 to 31. */
export const REGISTER_BITS = 5;
const MAX_RANK = 2 ** REGISTER_BITS - 1;

/** The register index and the rank (position of the first 1 bit) that a hash gives, for 2^indexBits registers. */
export function registerAndRank(hash: number, indexBits: number): { index: number; rank: number } {
  const index = hash >>> (32 - indexBits);
  const rest = (hash << indexBits) >>> 0;
  return { index, rank: Math.min(MAX_RANK, rest === 0 ? 33 - indexBits : Math.clz32(rest) + 1) };
}
