import { describe, expect, it } from "vitest";
import { binomialUpper, clamp, clopperPearson, zForConfidence } from "./stats";

describe("zForConfidence", () => {
  it("matches standard normal quantiles", () => {
    expect(zForConfidence(0.9)).toBeCloseTo(1.6449, 3);
    expect(zForConfidence(0.95)).toBeCloseTo(1.96, 3);
    expect(zForConfidence(0.99)).toBeCloseTo(2.5758, 3);
  });

  it("rejects out-of-range confidence", () => {
    expect(() => zForConfidence(0)).toThrow(RangeError);
    expect(() => zForConfidence(1)).toThrow(RangeError);
  });
});

describe("binomialUpper", () => {
  it("handles degenerate cases", () => {
    expect(binomialUpper(0, 0.5, 0.95)).toBe(0);
    expect(binomialUpper(10, 0, 0.95)).toBe(0);
    expect(binomialUpper(10, 1, 0.95)).toBe(10);
  });

  it("returns the smallest q whose CDF reaches the confidence", () => {
    // Binomial(10, 0.5): CDF(7) = 0.9453, CDF(8) = 0.9893.
    expect(binomialUpper(10, 0.5, 0.95)).toBe(8);
    // Binomial(12, 0.05): P(0) = 0.540, P(<=1) = 0.882, P(<=2) = 0.980.
    expect(binomialUpper(12, 0.05, 0.95)).toBe(2);
  });
});

describe("clopperPearson", () => {
  // Published exact 95% intervals (e.g. from standard binomial CI tables).
  it.each([
    [0, 10, 0, 0.3085],
    [1, 10, 0.0025, 0.445],
    [5, 10, 0.1871, 0.8129],
    [10, 10, 0.6915, 1],
  ])("%i hits in %i trials gives [%f, %f]", (hits, n, low, high) => {
    const ci = clopperPearson(hits, n, 0.95);
    expect(ci.low).toBeCloseTo(low, 3);
    expect(ci.high).toBeCloseTo(high, 3);
  });

  it("does not underflow for large n", () => {
    const ci = clopperPearson(50000, 100000, 0.95);
    expect(ci.low).toBeGreaterThan(0.49);
    expect(ci.high).toBeLessThan(0.51);
  });

  it("rejects impossible inputs", () => {
    expect(() => clopperPearson(5, 4, 0.95)).toThrow(RangeError);
    expect(() => clopperPearson(-1, 4, 0.95)).toThrow(RangeError);
  });
});

describe("clamp", () => {
  it("bounds a value", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
