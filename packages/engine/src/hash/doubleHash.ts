import { murmur3U32 } from "./murmur3";

/**
 * The fixed seed used by every structure that is not Seeded. It is public on purpose:
 * the Cunning trait attacks unseeded structures by hashing with exactly this value.
 */
export const PUBLIC_HASH_SEED = 0x5bd1e995;

/** Offset giving the second base hash an independent seed. */
const SECOND_HASH_SALT = 0x9e3779b9;

export interface HashPair {
  h1: number;
  h2: number;
}

/** The two base hashes for Kirsch-Mitzenmacher double hashing. */
export function hashPair(value: number, seed: number): HashPair {
  return {
    h1: murmur3U32(value, seed),
    h2: murmur3U32(value, (seed ^ SECOND_HASH_SALT) >>> 0),
  };
}

/**
 * Enhanced double hashing (Dillinger & Manolios):
 *
 *   h_i = h1 + i * h2 + (i^3 - i) / 6   (mod m)
 *
 * This is Kirsch-Mitzenmacher double hashing, h_i = h1 + i * h2, plus a tetrahedral-number term
 * (0, 0, 1, 4, 10, ...). Plain double hashing puts all k positions on one arithmetic progression, which collapses
 * whenever h2 shares a factor with m: a value whose progression cycles in fewer than k steps behaves as if it had
 * fewer hashes, inflating false positives by about 1.5 / m regardless of k (see notes/dev/2026-10-09.md).
 * The cubic term stops positions from repeating in lockstep. Both base hashes are reduced mod m first so the
 * arithmetic stays exact.
 */
export function nthHash(pair: HashPair, i: number, modulus: number): number {
  const tetrahedral = (i * i * i - i) / 6;
  return ((pair.h1 % modulus) + i * (pair.h2 % modulus) + (tetrahedral % modulus)) % modulus;
}

/** The k indices in [0, modulus) that a value maps to. */
export function doubleHashIndices(value: number, k: number, modulus: number, seed: number): number[] {
  const pair = hashPair(value, seed);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(nthHash(pair, i, modulus));
  return out;
}
