import { describe, expect, it } from "vitest";
import traitsJson from "../traits.json";
import { parseTraits, traits, weakPointWeights } from "./traits";

describe("traits.json", () => {
  it("carries the spec's level tables; rejects a missing level, an unknown weak point, a negative weight and an extra key", () => {
    // carries the spec's level tables
    {
      expect(traits.levels.variety).toEqual({ low: 2 ** 8, medium: 2 ** 14, high: 2 ** 22 });
      expect(traits.levels.skew).toEqual({ low: 0, medium: 0.8, high: 1.2 });
      expect(traits.levels.churn).toEqual({ low: 0, medium: 0.1, high: 0.3 });
      expect(traits.levels.growth).toEqual({ low: 1, medium: 1.15, high: 1.35 });
      expect(traits.levels.drift).toEqual({
        low: { fraction: 0, everyTurns: 0 },
        medium: { fraction: 0.25, everyTurns: 4 },
        high: { fraction: 0.5, everyTurns: 3 },
      });
    }
    // rejects a missing level, an unknown weak point, a negative weight and an extra key
    {
      const { low: _low, ...skewWithoutLow } = traitsJson.levels.skew;
      void _low;
      expect(() => parseTraits({ ...traitsJson, levels: { ...traitsJson.levels, skew: skewWithoutLow } })).toThrow();
      expect(() => parseTraits({ ...traitsJson, weakPointHints: { skew: { high: { rank: 1 } } } })).toThrow();
      expect(() => parseTraits({ ...traitsJson, weakPointHints: { skew: { high: { frequency: -1 } } } })).toThrow();
      expect(() => parseTraits({ ...traitsJson, extra: 1 })).toThrow();
    }
  });
});

describe("weakPointWeights", () => {
  const calm = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low" } as const;

  it("gives every weak point its base weight when no trait hints at one; adds a trait's hint to the weak point it points at", () => {
    // gives every weak point its base weight when no trait hints at one
    {
      expect(weakPointWeights(calm)).toEqual({ presence: 1, frequency: 1, count: 1, rank: traits.rankWeight }); // Rank starts at its own weight
    }
    // adds a trait's hint to the weak point it points at
    {
      expect(weakPointWeights({ ...calm, skew: "high" })).toEqual({ presence: 1, frequency: 4, count: 1, rank: traits.rankWeight });
      expect(weakPointWeights({ ...calm, variety: "high", churn: "medium" })).toEqual({ presence: 2, frequency: 1, count: 4, rank: traits.rankWeight });
    }
  });
});
