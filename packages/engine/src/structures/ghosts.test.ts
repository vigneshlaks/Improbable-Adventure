import { describe, expect, it } from "vitest";
import { binomialUpper, zForConfidence } from "../stats/stats";
import { deletedShare, expectedGhostShare, liveCountRange } from "./ghosts";

const everRange = () => {
  const asked: number[] = [];
  const ever = (confidence: number) => {
    asked.push(confidence);
    return { estimate: 100, low: 90, high: 110 };
  };
  return { ever, asked };
};

describe("deletedShare", () => {
  it("is the share of inserted units that have been deleted", () => {
    expect(deletedShare(200, 20)).toBe(0.1);
    expect(deletedShare(100, 0)).toBe(0);
  });

  it("never exceeds 1, and is 1 when there were deletes but no inserts (a structure deployed late)", () => {
    expect(deletedShare(10, 50)).toBe(1);
    expect(deletedShare(0, 3)).toBe(1);
  });

  it("is 0 when nothing happened", () => {
    expect(deletedShare(0, 0)).toBe(0);
  });
});

describe("expectedGhostShare", () => {
  it("is 0 when no delete was seen", () => {
    expect(expectedGhostShare(500, 0, 100)).toBe(0);
  });

  it("is the deleted share when every value has one unit, since each deleted unit then removes a value", () => {
    expect(expectedGhostShare(100, 40, 100)).toBeCloseTo(0.4, 12);
  });

  it("shrinks as values have more units, because a value is only a ghost once all of its units are gone", () => {
    // 1,000 inserts over 100 values: 10 units each. Half deleted: q^10-ish, so almost no ghosts.
    expect(expectedGhostShare(1000, 500, 100)).toBeCloseTo(0.5 * Math.exp(-9 * 0.5), 12);
    expect(expectedGhostShare(200, 100, 100)).toBeLessThan(expectedGhostShare(100, 50, 100));
  });

  it("falls back to the deleted share when there is nothing to divide by", () => {
    expect(expectedGhostShare(0, 5, 100)).toBe(1);
    expect(expectedGhostShare(100, 40, 0)).toBeCloseTo(0.4, 12);
  });

  it("never exceeds the deleted share, so a ghost never needs more deletes than were seen", () => {
    for (const [inserts, deletes, ever] of [[100, 10, 100], [300, 120, 50], [50, 50, 10], [10, 500, 4]] as const) {
      expect(expectedGhostShare(inserts, deletes, ever)).toBeLessThanOrEqual(deletedShare(inserts, deletes));
    }
  });
});

describe("liveCountRange", () => {
  it("leaves the range alone when no delete has been seen", () => {
    const { ever, asked } = everRange();
    expect(liveCountRange(ever, 500, 0, 0.95)).toEqual({ estimate: 100, low: 90, high: 110 });
    expect(asked).toEqual([0.95]);
  });

  it("asks for a tighter range from the structure when deletes were seen, so the sources of error share the budget", () => {
    const { ever, asked } = everRange();
    liveCountRange(ever, 500, 20, 0.95);
    expect(asked).toEqual([0.975]);
  });

  it("lowers only the low bound, by the ghosts a binomial in the deleted share allows, at most the number of deletes", () => {
    const { ever } = everRange();
    // 200 inserts, 20 deletes: q = 0.1. Ghosts among 90 values: at most binomialUpper(90, 0.1, 0.975).
    const expected = Math.min(20, binomialUpper(90, 0.1, 0.975));
    expect(expected).toBeLessThan(20); // the binomial, not the cap, decides here
    expect(liveCountRange(ever, 200, 20, 0.95)).toMatchObject({ low: 90 - expected, high: 110 });
  });

  it("is capped by the number of deletes, because every ghost needs one", () => {
    const { ever } = everRange();
    // 40 inserts, 20 deletes: q = 0.5. The binomial would allow about 54 ghosts, but there were only 20 deletes.
    expect(binomialUpper(90, 0.5, 0.975)).toBeGreaterThan(20);
    expect(liveCountRange(ever, 40, 20, 0.95).low).toBe(70);
  });

  it("never goes below zero", () => {
    const { ever } = everRange();
    expect(liveCountRange(ever, 10, 500, 0.95).low).toBe(0);
  });

  it("moves the estimate down by the ghosts to expect, and only the estimate and the low bound", () => {
    const { ever } = everRange();
    // 100 inserts and 40 deletes over about 100 values: each value has about one unit, so about 40 percent are ghosts.
    const singles = liveCountRange(ever, 100, 40, 0.95);
    expect(singles.estimate).toBeCloseTo(100 * (1 - 0.4), 9);
    expect(singles.high).toBe(110);
    // 1,000 inserts over the same 100 values: ten units each, so deleting half removes almost no value.
    expect(liveCountRange(ever, 1000, 500, 0.95).estimate).toBeCloseTo(100 * (1 - 0.5 * Math.exp(-4.5)), 9);
  });

  it("leaves the estimate where it was when no delete was seen", () => {
    const { ever } = everRange();
    expect(liveCountRange(ever, 100, 0, 0.95).estimate).toBe(100);
  });

  it("keeps an infinite upper bound", () => {
    const open = () => ({ estimate: 300, low: 200, high: Infinity });
    expect(liveCountRange(open, 100, 10, 0.95).high).toBe(Infinity);
  });

  it("keeps the estimate inside the range", () => {
    const wide = () => ({ estimate: 40, low: 30, high: 50 });
    const { estimate, low, high } = liveCountRange(wide, 40, 20, 0.95);
    expect(estimate).toBeGreaterThanOrEqual(low);
    expect(estimate).toBeLessThanOrEqual(high);
  });

  it("uses a confidence the normal quantile can handle", () => {
    expect(() => zForConfidence(0.975)).not.toThrow();
  });
});
