import { describe, expect, it } from "vitest";
import { createZipfSampler } from "./zipf";
import { CHI2_999, chiSquare, rngFor } from "./testUtils";

/** Exact Zipf probabilities for ranks 1..n. */
function pmf(n: number, s: number): number[] {
  const weights = Array.from({ length: n }, (_, i) => Math.pow(i + 1, -s));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

describe("createZipfSampler", () => {
  it.each([
    [0, 20, 19],
    [0.8, 50, 49],
    [1, 50, 49],
    [1.2, 50, 49],
  ])("matches the Zipf distribution for s = %f over %i ranks", (s, n, df) => {
    const sample = createZipfSampler(n, s);
    const rng = rngFor(`zipf-${s}`);
    const draws = 200000;
    const observed = new Array<number>(n).fill(0);
    for (let i = 0; i < draws; i++) {
      const rank = sample(rng);
      expect(rank).toBeGreaterThanOrEqual(1);
      expect(rank).toBeLessThanOrEqual(n);
      observed[rank - 1] = (observed[rank - 1] ?? 0) + 1;
    }
    const expected = pmf(n, s).map((p) => p * draws);
    expect(chiSquare(observed, expected)).toBeLessThan(CHI2_999[df] as number);
  });

  it("handles a single rank", () => {
    const sample = createZipfSampler(1, 1.2);
    const rng = rngFor("zipf-one");
    for (let i = 0; i < 100; i++) expect(sample(rng)).toBe(1);
  });

  it("works at the largest Variety size without building a table", () => {
    const n = 2 ** 22;
    const s = 1.2;
    const sample = createZipfSampler(n, s);
    const rng = rngFor("zipf-large");
    const draws = 100000;
    let top = 0;
    for (let i = 0; i < draws; i++) {
      const rank = sample(rng);
      expect(rank).toBeLessThanOrEqual(n);
      if (rank === 1) top++;
    }
    let total = 0;
    for (let k = 1; k <= n; k++) total += Math.pow(k, -s);
    const p = 1 / total;
    const sigma = Math.sqrt(draws * p * (1 - p));
    expect(Math.abs(top - draws * p)).toBeLessThan(4 * sigma);
  });

  it("is deterministic for a given generator", () => {
    const sample = createZipfSampler(1000, 0.8);
    const a = rngFor("zipf-det");
    const b = rngFor("zipf-det");
    for (let i = 0; i < 200; i++) expect(sample(a)).toBe(sample(b));
  });

  it("rejects bad parameters", () => {
    expect(() => createZipfSampler(0, 1)).toThrow(RangeError);
    expect(() => createZipfSampler(10, -1)).toThrow(RangeError);
  });
});
