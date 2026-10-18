import { describe, expect, it } from "vitest";
import { binomialBelow, orderStatisticRange, quantileOfSorted, thinningShift } from "./quantiles";
import { coverageFloor, TRIALS, trialRng } from "./testUtils";

describe("quantiles", () => {
  it("finds the smallest value with the wanted share at or below it; computes the chance of fewer than j successes exactly; and gives a range from order statistics that is wider for a small sample and for more confidence", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(quantileOfSorted(sorted, 0.5)).toBe(50);
    expect(quantileOfSorted(sorted, 0.51)).toBe(60);
    expect(quantileOfSorted(sorted, 1)).toBe(100);
    expect(quantileOfSorted(sorted, 0.0001)).toBe(10);
    expect(quantileOfSorted([7], 0.9)).toBe(7);

    // P(Binomial(4, 0.5) < j), checked by hand: 1/16, 5/16, 11/16, 15/16
    expect(binomialBelow(4, 0.5, 0)).toBe(0);
    expect(binomialBelow(4, 0.5, 1)).toBeCloseTo(1 / 16, 12);
    expect(binomialBelow(4, 0.5, 2)).toBeCloseTo(5 / 16, 12);
    expect(binomialBelow(4, 0.5, 3)).toBeCloseTo(11 / 16, 12);
    expect(binomialBelow(4, 0.5, 4)).toBeCloseTo(15 / 16, 12);
    expect(binomialBelow(4, 0.5, 5)).toBe(1);
    expect(binomialBelow(10, 0, 3)).toBe(1);
    expect(binomialBelow(10, 1, 3)).toBe(0);

    // The range brackets the estimate and widens as the sample shrinks or the confidence rises.
    const big = Array.from({ length: 1000 }, (_, i) => i + 1);
    const small = Array.from({ length: 50 }, (_, i) => (i + 1) * 20);
    const wide = orderStatisticRange(big, 0.5, 0.95);
    expect(wide.low).toBeLessThanOrEqual(wide.estimate);
    expect(wide.estimate).toBeLessThanOrEqual(wide.high);
    expect(wide.estimate).toBe(500);
    expect(orderStatisticRange(big, 0.5, 0.99).high - orderStatisticRange(big, 0.5, 0.99).low).toBeGreaterThan(wide.high - wide.low);
    const little = orderStatisticRange(small, 0.5, 0.95);
    const rankSpan = (r: { low: number; high: number }, values: readonly number[]) => values.filter((v) => v > r.low && v <= r.high).length / values.length;
    expect(rankSpan(little, small)).toBeGreaterThan(rankSpan(wide, big));
    // A sample too small to bound a high quantile from above says so.
    expect(orderStatisticRange([1, 2, 3, 4, 5], 0.99, 0.95).high).toBe(Number.POSITIVE_INFINITY);
    // A shift widens both ends in quantile terms
    expect(orderStatisticRange(big, 0.5, 0.95, 0.05).high).toBeGreaterThan(wide.high);
    expect(orderStatisticRange(big, 0.5, 0.95, 0.05).low).toBeLessThan(wide.low);
    // thinning noise falls with the units left
    expect(thinningShift(100, 0.5, 0.95)).toBeGreaterThan(thinningShift(10000, 0.5, 0.95));
    expect(thinningShift(0, 0.5, 0.95)).toBe(1);
  });

  it("puts the ends of the range at the order statistics the binomial gives: the largest j with fewer than j below the quantile at most tail, and the smallest k with at most k - 1 below it at least 1 - tail", () => {
    for (const n of [10, 20, 40]) {
      for (const q of [0.5, 0.9]) {
        const sorted = Array.from({ length: n }, (_, i) => i + 1); // the value is its own 1-based position
        const tail = 0.025;
        let j = 1;
        while (j + 1 <= n && binomialBelow(n, q, j + 1) <= tail) j++;
        let k = n + 1; // none: the sample cannot bound it from above
        for (let candidate = 1; candidate <= n; candidate++) {
          if (binomialBelow(n, q, candidate) >= 1 - tail) {
            k = candidate;
            break;
          }
        }
        const range = orderStatisticRange(sorted, q, 0.95);
        expect(range.low, `n ${n}, q ${q}`).toBe(binomialBelow(n, q, 1) <= tail ? j : 1);
        expect(range.high, `n ${n}, q ${q}`).toBe(k > n ? Number.POSITIVE_INFINITY : k);
      }
    }
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    it("brackets the population quantile with the stated confidence, for a spread of sample sizes and quantiles", () => {
      for (const n of [20, 100, 400]) {
        for (const q of [0.5, 0.9]) {
          let covered = 0;
          for (let t = 0; t < TRIALS; t++) {
            const rng = trialRng(`order-stat-${n}-${q}`, t);
            const sample = Array.from({ length: n }, () => rng.float()).sort((a, b) => a - b); // uniform on [0, 1): the q-quantile is q
            const range = orderStatisticRange(sample, q, 0.95);
            if (range.low <= q && q <= range.high) covered++;
          }
          expect(covered / TRIALS, `n ${n}, q ${q}`).toBeGreaterThanOrEqual(coverageFloor(0.95, TRIALS));
        }
      }
    });
  });
});
