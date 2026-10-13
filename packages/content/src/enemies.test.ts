import { describe, expect, it } from "vitest";
import { balance } from "./balance";
import { generateEnemy, type TierName } from "./enemies";

const TIERS: TierName[] = ["minion", "elite", "boss"];
const nonLow = (traits: object) => Object.values(traits).filter((level) => level !== "low").length;

describe("generateEnemy", () => {
  it.each(TIERS)("%s: copies its numbers from the tier table", (tier) => {
    const enemy = generateEnemy("seed", tier);
    const spec = balance.TIERS[tier];
    expect(enemy).toMatchObject({ tier, size: spec.size, hp: spec.hp, attack: spec.attack, turnLimit: spec.turnLimit });
  });

  it.each(TIERS)("%s: has the right number of non-Low traits and weak points", (tier) => {
    const spec = balance.TIERS[tier];
    const counts = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const enemy = generateEnemy(`count-${i}`, tier);
      const n = nonLow(enemy.traits);
      expect(n).toBeGreaterThanOrEqual(spec.traitCount.min);
      expect(n).toBeLessThanOrEqual(spec.traitCount.max);
      expect(enemy.weakPoints.length).toBeGreaterThanOrEqual(spec.weakPointCount.min);
      expect(enemy.weakPoints.length).toBeLessThanOrEqual(spec.weakPointCount.max);
      expect(new Set(enemy.weakPoints).size).toBe(enemy.weakPoints.length); // no repeats
      counts.add(n);
    }
    // Tiers with a range of trait counts use all of it.
    expect(counts.size).toBe(spec.traitCount.max - spec.traitCount.min + 1);
  });

  it("is deterministic in its seed and varies across seeds", () => {
    expect(generateEnemy("same", "elite")).toEqual(generateEnemy("same", "elite"));
    const designs = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(generateEnemy(`vary-${i}`, "elite"))));
    expect(designs.size).toBeGreaterThan(10);
  });

  it("uses High more often at higher tiers", () => {
    const highShare = (tier: TierName) => {
      let high = 0;
      let total = 0;
      for (let i = 0; i < 400; i++) {
        for (const level of Object.values(generateEnemy(`level-${i}`, tier).traits)) {
          if (level === "low") continue;
          total++;
          if (level === "high") high++;
        }
      }
      return high / total;
    };
    expect(highShare("minion")).toBeLessThan(highShare("elite"));
    expect(highShare("elite")).toBeLessThan(highShare("boss"));
  });

  it("lets traits hint at the weak point: a Minion whose only strong trait is high Skew is mostly a Frequency enemy", () => {
    let frequency = 0;
    let matching = 0;
    for (let i = 0; i < 40000; i++) {
      const enemy = generateEnemy(`hint-${i}`, "minion");
      const strong = Object.entries(enemy.traits).filter(([, level]) => level !== "low");
      if (strong.length !== 1 || strong[0]?.[0] !== "skew" || strong[0]?.[1] !== "high") continue;
      matching++;
      if (enemy.weakPoints[0] === "frequency") frequency++;
    }
    expect(matching).toBeGreaterThan(500);
    // Weights are frequency 4 against 1 and 1, so about two thirds.
    const sigma = Math.sqrt(matching * (2 / 3) * (1 / 3));
    expect(Math.abs(frequency - matching * (2 / 3))).toBeLessThan(4 * sigma);
  });
});
