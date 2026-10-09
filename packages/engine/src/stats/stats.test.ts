import { describe, expect, it } from "vitest";
import { binomialUpper, clamp, zForConfidence } from "./stats";

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

describe("clamp", () => {
  it("bounds a value", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
