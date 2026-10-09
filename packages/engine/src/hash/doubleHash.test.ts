import { describe, expect, it } from "vitest";
import { doubleHashIndices, hashPair, nthHash, PUBLIC_HASH_SEED } from "./doubleHash";

describe("double hashing", () => {
  it("follows h_i = h1 + i * h2 (mod m)", () => {
    const m = 1009;
    const pair = hashPair(12345, PUBLIC_HASH_SEED);
    const indices = doubleHashIndices(12345, 6, m, PUBLIC_HASH_SEED);
    for (let i = 0; i < 6; i++) {
      expect(indices[i]).toBe(((pair.h1 % m) + i * (pair.h2 % m)) % m);
      expect(indices[i]).toBe(nthHash(pair, i, m));
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
