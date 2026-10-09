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

/** h_i = h1 + i * h2 (mod m), with both base hashes reduced mod m first so the arithmetic stays exact. */
export function nthHash(pair: HashPair, i: number, modulus: number): number {
  return ((pair.h1 % modulus) + i * (pair.h2 % modulus)) % modulus;
}

/** The k indices in [0, modulus) that a value maps to. */
export function doubleHashIndices(value: number, k: number, modulus: number, seed: number): number[] {
  const pair = hashPair(value, seed);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(nthHash(pair, i, modulus));
  return out;
}
