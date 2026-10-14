import { describe, expect, it } from "vitest";
import { binomialUpper, zForConfidence } from "../stats/stats";
import { deletedShare, liveCountRange } from "./ghosts";

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
