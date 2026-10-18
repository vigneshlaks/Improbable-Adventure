// MurmurHash3 (x86, 32-bit) and the "enhanced double hashing" that derives k positions from two base hashes.
// Everything here takes a seed, so the same data and seed give the same result in every language of this toolkit.

/** The seed used when none is given. Public on purpose; pass your own secret seed if inputs may be adversarial. */
export const DEFAULT_SEED = 0x5bd1e995;

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const SECOND_HASH_SALT = 0x9e3779b9;

const rotl32 = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

function fmix32(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

const mixK = (k: number): number => Math.imul(rotl32(Math.imul(k, C1), 15), C2);
const mixH = (h: number, k: number): number => (Math.imul(rotl32(h ^ k, 13), 5) + 0xe6546b64) | 0;

/** Hashes bytes to an unsigned 32-bit integer. */
export function hashBytes(data: Uint8Array, seed = 0): number {
  const blocks = data.length >>> 2;
  let h = seed | 0;
  for (let i = 0; i < blocks; i++) {
    const o = i * 4;
    const k = (data[o] as number) | ((data[o + 1] as number) << 8) | ((data[o + 2] as number) << 16) | ((data[o + 3] as number) << 24);
    h = mixH(h, mixK(k));
  }
  const tail = blocks * 4;
  const remaining = data.length & 3;
  if (remaining > 0) {
    let k = data[tail] as number;
    if (remaining > 1) k ^= (data[tail + 1] as number) << 8;
    if (remaining > 2) k ^= (data[tail + 2] as number) << 16;
    h ^= mixK(k);
  }
  return fmix32(h ^ data.length);
}

export type Item = number | string | Uint8Array;

/** Hashes an item: a string by its UTF-8 bytes, an integer from 0 to 2^32 - 1 by its four little-endian bytes. */
export function hash32(item: Item, seed = 0): number {
  if (typeof item === "string") return hashBytes(new TextEncoder().encode(item), seed);
  if (typeof item === "number") {
    if (!Number.isInteger(item) || item < 0 || item > 0xffffffff) throw new RangeError("A numeric item must be an integer from 0 to 2^32 - 1");
    return fmix32(mixH(seed | 0, mixK(item | 0)) ^ 4);
  }
  return hashBytes(item, seed);
}

/** The k positions in [0, modulus) of an item: h1 + i * h2 + (i^3 - i) / 6, all taken modulo the table size. */
export function positions(item: Item, k: number, modulus: number, seed = DEFAULT_SEED): number[] {
  const h1 = hash32(item, seed) % modulus;
  const h2 = hash32(item, (seed ^ SECOND_HASH_SALT) >>> 0) % modulus;
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push((h1 + i * h2 + (((i * i * i - i) / 6) % modulus)) % modulus);
  return out;
}
