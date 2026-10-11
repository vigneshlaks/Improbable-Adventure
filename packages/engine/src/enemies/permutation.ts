import { murmur3U32 } from "../hash/murmur3";

const ROUNDS = 4;

/**
 * A seeded permutation of 0..n-1 that needs no table: each lookup takes a few hash calls.
 *
 * It is a Feistel network (the construction behind many block ciphers) over the smallest even bit width
 * that covers n, with "cycle walking" to skip outputs that fall outside 0..n-1.
 * Used to assign values to Zipf ranks without storing a million-entry shuffle in the saved state.
 */
export function makePermutation(n: number, key: number): (x: number) => number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`makePermutation needs 1 <= n <= 2^32, got ${n}`);
  if (n === 1) {
    return (x) => {
      if (x !== 0) throw new RangeError(`Permutation input ${x} is outside 0..0`);
      return 0;
    };
  }

  let bits = 0;
  while (2 ** bits < n) bits++;
  const half = Math.ceil(bits / 2);
  const mask = 2 ** half - 1;

  const roundFunction = (value: number, round: number) =>
    murmur3U32(value, (key + Math.imul(round + 1, 0x9e3779b9)) >>> 0) & mask;

  const feistel = (x: number): number => {
    let left = x >>> half;
    let right = x & mask;
    for (let round = 0; round < ROUNDS; round++) {
      [left, right] = [right, left ^ roundFunction(right, round)];
    }
    return ((left << half) | right) >>> 0;
  };

  return (x) => {
    if (!Number.isInteger(x) || x < 0 || x >= n) throw new RangeError(`Permutation input ${x} is outside 0..${n - 1}`);
    let y = feistel(x);
    while (y >= n) y = feistel(y);
    return y;
  };
}
