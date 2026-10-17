import { describe, expect, it } from "vitest";
import { balance, buildFightConfig } from "@pda/content";
import { STRUCTURE_KINDS } from "@pda/engine";
import { getBot } from "./bots";
import { runFights, summarize } from "./report";
import { META, RECORDS } from "./reportFixtures";
import { playFight } from "./runner";
import { minion } from "./testUtils";
import { wilsonInterval } from "./stats";

describe("summarize", () => {
  const report = summarize(RECORDS, META);

  it("counts outcomes and gives the win rate with an interval; averages turns and the Certainty left; averages Certainty lost by cause; and 7 more", () => {
    // counts outcomes and gives the win rate with an interval
    {
      expect(report).toMatchObject({ bot: "greedy", tier: "minion", loadout: "starting", seedBase: 1, fights: 4 });
      expect(report.outcomes).toEqual({ won: 2, lost: 2, stalled: 0, lostToTurnLimit: 1, lostToCertainty: 1 });
      expect(report.winRate).toBe(0.5);
      expect(report.winRateInterval).toEqual(wilsonInterval(2, 4));
    }
    // averages turns and the Certainty left
    {
      expect(report.meanTurns).toBe(5.5); // (4 + 8 + 4 + 6) / 4
      expect(report.meanCertaintyLeft).toBe(50); // (80 + 30 + 90 + 0) / 4
    }
    // averages Certainty lost by cause
    {
      expect(report.meanCertaintyLost).toEqual({ blocked: 6.75, decoys: 2, misses: 0.75, attacks: 15, turnLimit: 5 });
    }
    // reports strikes per fight and the share that were wrong
    {
      expect(report.strikes.meanPerFight).toBe(4.25); // 17 strikes in 4 fights
      expect(report.strikes.wrongShare).toBeCloseTo(12 / 17, 10);
    }
    // reports how often each structure was deployed and how often those fights were won
    {
      expect(report.structures.countMinSketch).toEqual({ deployedShare: 0.75, winRateWhenDeployed: 2 / 3 });
      expect(report.structures.bloomFilter).toEqual({ deployedShare: 0.75, winRateWhenDeployed: 1 / 3 });
      expect(report.structures.logLog).toBeUndefined(); // never deployed
    }
    // reports how often each structure's range held the truth, against what it claimed
    {
      expect(report.accuracy.countMinSketch).toMatchObject({ answers: 3, withinRange: 2 / 3 });
      expect(report.accuracy.countMinSketch?.meanRelativeError).toBeCloseTo(0.2, 10); // (0.2 + 0.4) / 3
      expect(report.accuracy.countMinSketch?.statedConfidence).toBeCloseTo(0.98, 10);
      expect(report.accuracy.bloomFilter).toMatchObject({ answers: 3, withinRange: 2 / 3, meanRelativeError: null });
      expect(report.accuracy.bloomFilter?.statedConfidence).toBeCloseTo(0.95, 10);
      expect(report.accuracy.exactMemory).toBeUndefined();
    }
    // reports how often LogLog beat Linear Counting at Count challenges, and the most distinct values seen
    {
      expect(report.countDuel).toEqual({ fights: 2, challenges: 4, logLogCloserShare: 0.5, largestDistinct: 60000 });
    }
    // has no share to report when no Count challenge came up
    {
      const none = summarize([RECORDS[1]!, RECORDS[3]!], META);
      expect(none.countDuel).toEqual({ fights: 0, challenges: 0, logLogCloserShare: null, largestDistinct: 0 });
    }
    // handles fights that never struck or deployed anything
    {
      const quiet = summarize([{ ...RECORDS[0]!, strikes: { total: 0, wrong: 0 }, deployed: [], accuracy: {} }], META);
      expect(quiet.strikes).toEqual({ meanPerFight: 0, wrongShare: 0 });
      expect(quiet.structures).toEqual({});
    }
    // refuses to summarize nothing
    {
      expect(() => summarize([], META)).toThrow(RangeError);
    }
  });
});

describe("runFights", () => {
  const options = { bot: getBot("oracle"), tier: "minion", loadout: "starting", n: 12, seedBase: 1 } as const;

  it("plays the requested number of fights and reports them; gives the same report for the same seeds, and a different one for other seeds; only deploys structures in the chosen loadout; and 1 more", () => {
    // plays the requested number of fights and reports them
    {
      const report = runFights(options);
      expect(report).toMatchObject({ bot: "oracle", tier: "minion", loadout: "starting", seedBase: 1, fights: 12, winRate: 1 });
      // One perfect strike ends a Minion (HP 20) on turn 2, after a single enemy attack at the end of turn 1.
      expect(report.meanTurns).toBe(2);
      expect(report.meanCertaintyLeft).toBe(balance.STARTING_CERTAINTY - balance.TIERS.minion.attack);
      expect(report.structures).toEqual({});
    }
    // gives the same report for the same seeds, and a different one for other seeds
    {
      const greedy = { ...options, bot: getBot("greedy"), n: 20 };
      expect(runFights(greedy)).toEqual(runFights(greedy));
      expect(runFights({ ...greedy, seedBase: 500 })).not.toEqual(runFights(greedy));
    }
    // only deploys structures in the chosen loadout
    {
      const starting = runFights({ ...options, bot: getBot("greedy"), n: 25 });
      expect(Object.keys(starting.structures).sort()).toEqual(["bloomFilter", "exactMemory", "linearCounting", "reservoirSampling"].filter((kind) => kind in starting.structures));
      expect(starting.structures.countMinSketch).toBeUndefined();

      const full = runFights({ ...options, bot: getBot("greedy"), loadout: "full", n: 60 });
      expect(Object.keys(full.structures).every((kind) => (STRUCTURE_KINDS as readonly string[]).includes(kind))).toBe(true);
      expect(full.structures.countMinSketch).toBeDefined();
    }
    // rejects a bad count
    {
      expect(() => runFights({ ...options, n: 0 })).toThrow(RangeError);
      expect(() => runFights({ ...options, n: 2.5 })).toThrow(RangeError);
    }
  });
});

describe("the starting loadout", () => {
  it("can win Count fights: a Minion whose weak point is Count is not a loss before it starts", () => {
    // The loadout was once Exact Memory, Reservoir Sampling and Bloom Filter, which won none of these.
    let won = 0;
    const fights = 40;
    for (let i = 0; i < fights; i++) {
      const seed = `count-start-${i}`;
      const config = minion(seed, "count", [...buildFightConfig({ seed, tier: "minion" }).loadout]);
      if (playFight({ config, seed, bot: getBot("greedy") }).outcome === "won") won++;
    }
    expect(won / fights).toBeGreaterThan(0.8);
  });
});

describe("Frequency with a Count-Min Sketch", () => {
  it("is not a trap: a bot that deploys the sketch wins most Frequency Minions, as it does by gambling on Exact Memory", () => {
    // With squared falloff the sketch's overshoot (about 3x on these streams) cut its damage to a ninth and it won 32 percent,
    // against 75 percent for the Exact Memory gamble. Linear falloff makes the two routes comparable.
    const kit = [...buildFightConfig({ seed: "kit", tier: "minion" }).loadout, "countMinSketch" as const];
    let won = 0;
    const fights = 60;
    for (let i = 0; i < fights; i++) {
      const seed = `freq-cms-${i}`;
      if (playFight({ config: minion(seed, "frequency", kit), seed, bot: getBot("greedy") }).outcome === "won") won++;
    }
    expect(won / fights).toBeGreaterThan(0.55);
  });
});
