// MurmurHash3 x86 32-bit, implemented in-repo so results never depend on a library version.

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function fmix32(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function mixK(k: number): number {
  return Math.imul(rotl32(Math.imul(k, C1), 15), C2);
}

function mixH(h: number, k: number): number {
  return (Math.imul(rotl32(h ^ k, 13), 5) + 0xe6546b64) | 0;
}

function byteAt(data: Uint8Array, i: number): number {
  return data[i] ?? 0;
}

/** Hash arbitrary bytes. `seed` is taken modulo 2^32. Returns an unsigned 32-bit integer. */
export function murmur3Bytes(data: Uint8Array, seed = 0): number {
  const len = data.length;
  const blocks = len >>> 2;
  let h = seed | 0;

  for (let i = 0; i < blocks; i++) {
    const o = i * 4;
    const k =
      byteAt(data, o) | (byteAt(data, o + 1) << 8) | (byteAt(data, o + 2) << 16) | (byteAt(data, o + 3) << 24);
    h = mixH(h, mixK(k));
  }

  const tail = blocks * 4;
  const remaining = len & 3;
  if (remaining > 0) {
    let k = byteAt(data, tail);
    if (remaining > 1) k ^= byteAt(data, tail + 1) << 8;
    if (remaining > 2) k ^= byteAt(data, tail + 2) << 16;
    h ^= mixK(k);
  }

  return fmix32(h ^ len);
}

/** Hash a uint32 as its four little-endian bytes. Equivalent to murmur3Bytes on those bytes, but allocation-free. */
export function murmur3U32(value: number, seed = 0): number {
  const h = mixH(seed | 0, mixK(value | 0));
  return fmix32(h ^ 4);
}

/** UTF-8 encode without TextEncoder, so the engine needs no platform globals. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** Hash a string via its UTF-8 bytes. */
export function murmur3String(text: string, seed = 0): number {
  return murmur3Bytes(utf8Bytes(text), seed);
}
