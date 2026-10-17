import { describe, expect, it } from "vitest";
import { wilsonInterval } from "./stats";

describe("wilsonInterval", () => {
  it("brackets an even split symmetrically; stays inside 0 and 1 at the extremes without collapsing to a point; narrows as there are more trials; and 1 more", () => {
    // brackets an even split symmetrically
    {
      const [low, high] = wilsonInterval(50, 100);
      expect(low).toBeCloseTo(0.4038, 3);
      expect(high).toBeCloseTo(0.5962, 3);
    }
    // stays inside 0 and 1 at the extremes without collapsing to a point
    {
      expect(wilsonInterval(0, 10)[0]).toBe(0);
      expect(wilsonInterval(0, 10)[1]).toBeCloseTo(0.2775, 3);
      expect(wilsonInterval(10, 10)[0]).toBeCloseTo(0.7225, 3);
      expect(wilsonInterval(10, 10)[1]).toBe(1);
    }
    // narrows as there are more trials
    {
      const small = wilsonInterval(5, 10);
      const large = wilsonInterval(500, 1000);
      expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
    }
    // rejects impossible counts
    {
      expect(() => wilsonInterval(1, 0)).toThrow(RangeError);
      expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
      expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    }
  });
});
