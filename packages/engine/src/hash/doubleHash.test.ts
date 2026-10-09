import { describe, expect, it } from "vitest";
import { doubleHashIndices, hashPair, nthHash, PUBLIC_HASH_SEED } from "./doubleHash";

describe("double hashing", () => {
  it("follows enhanced double hashing: h_i = h1 + i * h2 + (i^3 - i) / 6 (mod m)", () => {
    const m = 1009;
    const pair = hashPair(12345, PUBLIC_HASH_SEED);
    const indices = doubleHashIndices(12345, 8, m, PUBLIC_HASH_SEED);
    for (let i = 0; i < 8; i++) {
      const expected = ((pair.h1 % m) + i * (pair.h2 % m) + (i * i * i - i) / 6) % m;
      expect(indices[i]).toBe(expected);
      expect(indices[i]).toBe(nthHash(pair, i, m));
    }
  });

  it("adds tetrahedral numbers 0, 0, 1, 4, 10 on top of the plain progression", () => {
    const m = 1000003;
    const pair = { h1: 100, h2: 7 };
    const tetra = [0, 0, 1, 4, 10, 20];
    for (let i = 0; i < tetra.length; i++) {
      expect(nthHash(pair, i, m)).toBe(100 + i * 7 + (tetra[i] ?? 0));
    }
  });

  it("does not collapse when h2 is degenerate (a multiple of m), unlike plain double hashing", () => {
    const m = 8192;
    const k = 14;
    // Plain double hashing with h2 = 0 would put every position on h1.
    for (const h2 of [0, m, 2 * m, m / 2, m / 4, m / 8]) {
      const positions = new Set(Array.from({ length: k }, (_, i) => nthHash({ h1: 5, h2 }, i, m)));
      // Positions 0 and 1 can coincide (the cubic term is 0 for both), but the rest must spread out.
      expect(positions.size).toBeGreaterThanOrEqual(k - 1);
    }
  });

  it("is deterministic and stays within range", () => {
    const m = 97;
    for (let v = 0; v < 500; v++) {
      const a = doubleHashIndices(v, 5, m, PUBLIC_HASH_SEED);
      const b = doubleHashIndices(v, 5, m, PUBLIC_HASH_SEED);
      expect(a).toEqual(b);
      for (const idx of a) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(m);
      }
    }
  });

  it("gives independent base hashes and responds to the seed", () => {
    const p = hashPair(7, PUBLIC_HASH_SEED);
    expect(p.h1).not.toBe(p.h2);
    expect(hashPair(7, 1)).not.toEqual(hashPair(7, 2));
  });

  it("spreads indices roughly uniformly", () => {
    const m = 64;
    const counts = new Array<number>(m).fill(0);
    const n = 64000;
    for (let v = 0; v < n; v++) {
      const idx = doubleHashIndices(v, 1, m, PUBLIC_HASH_SEED)[0] ?? 0;
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    const expected = n / m;
    // Chi-square with 63 degrees of freedom; 0.999 quantile is about 103.
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(103);
  });
});
