import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { murmur3Bytes, murmur3String, murmur3U32, utf8Bytes } from "./murmur3";

// Published MurmurHash3_x86_32 reference vectors (SMHasher / Wikipedia / widely mirrored test suites).
const KNOWN_ANSWERS: Array<[string, number, number]> = [
  ["", 0, 0x00000000],
  ["", 1, 0x514e28b7],
  ["", 0xffffffff, 0x81f16f39],
  ["test", 0, 0xba6bd213],
  ["Hello, world!", 0, 0xc0363e43],
  ["The quick brown fox jumps over the lazy dog", 0, 0x2e4ff723],
  ["a", 0x9747b28c, 0x7fa09ea6],
  ["aa", 0x9747b28c, 0x5d211726],
  ["aaa", 0x9747b28c, 0x283e0130],
  ["aaaa", 0x9747b28c, 0x5a97808a],
  ["abc", 0x9747b28c, 0xc84a62dd],
  ["Hello, world!", 0x9747b28c, 0x24884cba],
  ["The quick brown fox jumps over the lazy dog", 0x9747b28c, 0x2fa826cd],
];

describe("murmur3 known answers", () => {
  it("matches the published known answers", () => {
    eachCase(KNOWN_ANSWERS.map((c) => [`hash(${JSON.stringify(c[0])}, seed ${c[1]})`, c] as const), ([text, seed, expected]) => {
      expect(murmur3String(text, seed)).toBe(expected);
    });
  });

  it("covers every tail length (0-3 trailing bytes) in the vectors above", () => {
    const lengths = new Set(KNOWN_ANSWERS.map(([text]) => text.length & 3));
    expect([...lengths].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("murmur3U32", () => {
  it("equals hashing the four little-endian bytes", () => {
    for (const value of [0, 1, 255, 256, 65535, 0x12345678, 0xdeadbeef, 0xffffffff]) {
      const bytes = Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
      for (const seed of [0, 1, 0x9747b28c, 0xffffffff]) {
        expect(murmur3U32(value, seed)).toBe(murmur3Bytes(bytes, seed));
      }
    }
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (let v = 0; v < 1000; v++) {
      const h = murmur3U32(v * 2654435761, 7);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("changes with the seed", () => {
    expect(murmur3U32(42, 1)).not.toBe(murmur3U32(42, 2));
  });
});

describe("utf8Bytes", () => {
  it("encodes ASCII, 2-, 3- and 4-byte code points like the standard", () => {
    expect([...utf8Bytes("A")]).toEqual([0x41]);
    expect([...utf8Bytes("é")]).toEqual([0xc3, 0xa9]);
    expect([...utf8Bytes("€")]).toEqual([0xe2, 0x82, 0xac]);
    expect([...utf8Bytes("😀")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});
