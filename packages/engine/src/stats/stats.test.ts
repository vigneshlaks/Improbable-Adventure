import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { binomialUpper, clamp, clopperPearson, zForConfidence } from "./stats";

describe("zForConfidence", () => {
  it("matches standard normal quantiles; rejects out-of-range confidence", () => {
    // matches standard normal quantiles
    {
      expect(zForConfidence(0.9)).toBeCloseTo(1.6449, 3);
      expect(zForConfidence(0.95)).toBeCloseTo(1.96, 3);
      expect(zForConfidence(0.99)).toBeCloseTo(2.5758, 3);
    }
    // rejects out-of-range confidence
    {
      expect(() => zForConfidence(0)).toThrow(RangeError);
      expect(() => zForConfidence(1)).toThrow(RangeError);
    }
  });
});

describe("binomialUpper", () => {
  it("handles degenerate cases; returns the smallest q whose CDF reaches the confidence", () => {
    // handles degenerate cases
    {
      expect(binomialUpper(0, 0.5, 0.95)).toBe(0);
      expect(binomialUpper(10, 0, 0.95)).toBe(0);
      expect(binomialUpper(10, 1, 0.95)).toBe(10);
    }
    // returns the smallest q whose CDF reaches the confidence
    {
      // Binomial(10, 0.5): CDF(7) = 0.9453, CDF(8) = 0.9893.
      expect(binomialUpper(10, 0.5, 0.95)).toBe(8);
      // Binomial(12, 0.05): P(0) = 0.540, P(<=1) = 0.882, P(<=2) = 0.980.
      expect(binomialUpper(12, 0.05, 0.95)).toBe(2);
    }
  });
});

describe("binomialUpper at large sizes", () => {
  // Binomial(100000, 0.5) has mean 50000 and standard deviation about 158, so the 95% upper bound is
  // near 50000 + 1.645 * 158 = 50260. Before the log-space fix this returned 100000.
  it("does not underflow; stays within the number of trials", () => {
    // does not underflow
    {
      const q = binomialUpper(100000, 0.5, 0.95);
      expect(q).toBeGreaterThan(50200);
      expect(q).toBeLessThan(50320);
    }
    // stays within the number of trials
    {
      expect(binomialUpper(1000000, 0.9, 0.99)).toBeLessThanOrEqual(1000000);
    }
  });
});

describe("clopperPearson", () => {
  // Published exact 95% intervals (e.g. from standard binomial CI tables).
  it("matches the published intervals; does not underflow for large n; rejects impossible inputs", () => {
    // matches the published intervals
    {
      const published: Array<[number, number, number, number]> = [
        [0, 10, 0, 0.3085],
        [1, 10, 0.0025, 0.445],
        [5, 10, 0.1871, 0.8129],
        [10, 10, 0.6915, 1],
      ];
      eachCase(published.map((c) => [`${c[0]} hits in ${c[1]} trials`, c] as const), ([hits, n, low, high]) => {
        const ci = clopperPearson(hits, n, 0.95);
        expect(ci.low).toBeCloseTo(low, 3);
        expect(ci.high).toBeCloseTo(high, 3);
      });
    }
    // does not underflow for large n
    {
      const ci = clopperPearson(50000, 100000, 0.95);
      expect(ci.low).toBeGreaterThan(0.49);
      expect(ci.high).toBeLessThan(0.51);
    }
    // rejects impossible inputs
    {
      expect(() => clopperPearson(5, 4, 0.95)).toThrow(RangeError);
      expect(() => clopperPearson(-1, 4, 0.95)).toThrow(RangeError);
    }
  });
});

describe("clamp", () => {
  it("bounds a value", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
