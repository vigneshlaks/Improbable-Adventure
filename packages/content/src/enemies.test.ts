import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { balance } from "./balance";
import { generateEnemy, type TierName } from "./enemies";
import { traits } from "./traits";

const TIERS: TierName[] = ["minion", "elite", "boss"];
const nonLow = (traits: object) => Object.values(traits).filter((level) => level !== "low").length;

describe("generateEnemy", () => {
  it("copies every tier's numbers from the tier table; gives every tier the right number of non-Low traits and weak points; is deterministic in its seed and varies across seeds; and 2 more", () => {
    // copies every tier's numbers from the tier table
    {
      eachCase(TIERS.map((tier) => [tier, tier] as const), (tier) => {
        const enemy = generateEnemy("seed", tier);
        const spec = balance.TIERS[tier];
        expect(enemy).toMatchObject({ tier, size: spec.size, hp: spec.hp, attack: spec.attack, turnLimit: spec.turnLimit });
      });
    }
    // gives every tier the right number of non-Low traits and weak points
    {
      eachCase(TIERS.map((tier) => [tier, tier] as const), (tier) => {
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
    }
    // is deterministic in its seed and varies across seeds
    {
      expect(generateEnemy("same", "elite")).toEqual(generateEnemy("same", "elite"));
      const designs = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(generateEnemy(`vary-${i}`, "elite"))));
      expect(designs.size).toBeGreaterThan(10);
    }
    // uses High more often at higher tiers
    {
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
    }
    // lets traits hint at the weak point: a Minion whose only strong trait is high Skew is mostly a Frequency enemy
    {
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
    }
  });
});

describe("Rank enemies", () => {
  const eager = { ...traits, rankWeight: 1000 }; // Rank is nearly always drawn, so the quantile can be seen
  it("never draw Rank while its weight is zero, and the enemies stay exactly as they were without it; draw it in a minority of enemies at the shipped weight; when Rank is in the pool, give it a quantile from the tier's list, and only then", () => {
    expect(traits.rankWeight).toBeGreaterThan(0);
    const off = { ...traits, rankWeight: 0 };
    for (const tier of TIERS) {
      for (let i = 0; i < 40; i++) {
        const enemy = generateEnemy(`off-${i}`, tier, balance, off);
        expect(enemy.weakPoints).not.toContain("rank");
        expect(enemy).not.toHaveProperty("rankQuantile");
      }
    }
    // At the shipped weight Rank is in the pool, but a minority of the enemies have it.
    let shipped = 0;
    for (let i = 0; i < 300; i++) if (generateEnemy(`ship-${i}`, "elite").weakPoints.includes("rank")) shipped++;
    expect(shipped).toBeGreaterThan(5);
    expect(shipped).toBeLessThan(150);
    const seen = new Set<number>();
    let withRank = 0;
    for (const tier of TIERS) {
      for (let i = 0; i < 60; i++) {
        const enemy = generateEnemy(`on-${i}`, tier, balance, eager);
        if (enemy.weakPoints.includes("rank")) {
          withRank++;
          expect(balance.RANK_QUANTILES[tier]).toContain(enemy.rankQuantile);
          if (tier === "boss") seen.add(enemy.rankQuantile as number);
        } else expect(enemy).not.toHaveProperty("rankQuantile");
      }
    }
    expect(withRank).toBeGreaterThan(150); // 180 enemies, almost all with Rank
    expect([...seen].sort()).toEqual([...balance.RANK_QUANTILES.boss].sort()); // every quantile of the list is used
  });
});

describe("Likeness and Cunning enemies", () => {
  it("draw the Cunning and Likeness traits like any other, and give Likeness as a weak point only to a Low Variety enemy", () => {
    const levels = { cunning: new Set<string>(), likeness: new Set<string>() };
    let likenessEnemies = 0;
    for (const tier of TIERS) {
      for (let i = 0; i < 200; i++) {
        const enemy = generateEnemy(`cl-${i}`, tier);
        levels.cunning.add(enemy.traits.cunning);
        levels.likeness.add(enemy.traits.likeness);
        if (enemy.weakPoints.includes("likeness")) {
          likenessEnemies++;
          expect(enemy.traits.variety).toBe("low");
        }
      }
    }
    expect([...levels.cunning].sort()).toEqual(["high", "low", "medium"]);
    expect([...levels.likeness].sort()).toEqual(["high", "low", "medium"]);
    expect(likenessEnemies).toBeGreaterThan(5);
  });
});
