import { describe, expect, it } from "vitest";
import { LiveSet } from "./liveSet";
import {
  burstSize,
  createStream,
  nextBurst,
  outsideValue,
  rankToValue,
  resolveStreamParams,
  type StreamParams,
  type StreamTraits,
  type TraitTables,
} from "./stream";

const TABLES: TraitTables = {
  variety: { low: 256, medium: 16384, high: 4194304 },
  skew: { low: 0, medium: 0.8, high: 1.2 },
  churn: { low: 0, medium: 0.1, high: 0.3 },
  growth: { low: 1, medium: 1.15, high: 1.35 },
  drift: {
    low: { fraction: 0, everyTurns: 0 },
    medium: { fraction: 0.25, everyTurns: 4 },
    high: { fraction: 0.5, everyTurns: 3 },
  },
  likeness: { low: { min: 0.05, max: 0.3 }, medium: { min: 0.35, max: 0.5 }, high: { min: 0.5, max: 0.58 } },
  cunning: { low: { events: 0, decoys: 0 }, medium: { events: 0.05, decoys: 0.5 }, high: { events: 0.15, decoys: 1 } },
};
const LOW: StreamTraits = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low", likeness: "low", cunning: "low" };
const params = (traits: Partial<StreamTraits> = {}, size = 1000): StreamParams =>
  resolveStreamParams(size, { ...LOW, ...traits }, TABLES, 5);

/** Run `turns` bursts, returning every event, the final state and the live set. */
function play(p: StreamParams, seed: string, turns: number) {
  let state = createStream(seed);
  const live = new LiveSet();
  const bursts = [];
  for (let t = 0; t < turns; t++) {
    const burst = nextBurst(p, state, live);
    state = burst.state;
    bursts.push(burst.events);
  }
  return { state, live, bursts };
}

describe("resolveStreamParams", () => {
  it("reads trait levels from the tables and sets the base burst size", () => {
    expect(params({ variety: "high", skew: "medium", churn: "high", growth: "medium", drift: "high" })).toEqual({
      universe: 4194304,
      skew: 0.8,
      churn: 0.3,
      growth: 1.15,
      drift: { fraction: 0.5, everyTurns: 3 },
      baseBurst: 200, // 1000 events over 5 expected turns
    });
  });
});

describe("burst size (Growth)", () => {
  it("is constant with no growth; compounds each turn, starting from the base on turn 1; generates exactly that many events per turn", () => {
    // is constant with no growth
    {
      expect([1, 2, 3, 4].map((t) => burstSize(params(), t))).toEqual([200, 200, 200, 200]);
    }
    // compounds each turn, starting from the base on turn 1
    {
      for (const [level, factor] of [["medium", 1.15], ["high", 1.35]] as const) {
        const p = params({ growth: level });
        expect(burstSize(p, 1)).toBe(200);
        for (let turn = 2; turn <= 6; turn++) {
          const exact = 200 * factor ** (turn - 1);
          expect(Math.abs(burstSize(p, turn) - exact)).toBeLessThanOrEqual(0.5 + 1e-9); // rounded to a whole event
        }
        expect(burstSize(p, 6)).toBeGreaterThan(burstSize(p, 5));
      }
    }
    // generates exactly that many events per turn
    {
      const p = params({ growth: "medium" });
      const { bursts } = play(p, "growth", 4);
      expect(bursts.map((b) => b.length)).toEqual([1, 2, 3, 4].map((t) => burstSize(p, t)));
    }
  });
});

describe("values (Variety)", () => {
  it("are uint32 and come from a universe of the stated size; map every rank to a distinct value; differ between seeds", () => {
    // are uint32 and come from a universe of the stated size
    {
      const p = params();
      const seen = new Set<number>();
      for (const burst of play(p, "universe", 5).bursts) {
        for (const e of burst) {
          expect(Number.isInteger(e.value)).toBe(true);
          expect(e.value).toBeGreaterThanOrEqual(0);
          expect(e.value).toBeLessThan(2 ** 32);
          seen.add(e.value);
        }
      }
      expect(seen.size).toBeLessThanOrEqual(256);
      expect(seen.size).toBeGreaterThan(200); // 1,000 uniform draws over 256 values cover nearly all of them
    }
    // map every rank to a distinct value
    {
      const p = params();
      const values = new Set(Array.from({ length: p.universe }, (_, rank) => rankToValue(p, "bijection", 0, rank)));
      expect(values.size).toBe(p.universe);
    }
    // differ between seeds
    {
      const p = params();
      expect(rankToValue(p, "seed-a", 0, 0)).not.toBe(rankToValue(p, "seed-b", 0, 0));
    }
  });
});

describe("outside values", () => {
  it("are never emitted by the enemy, and are distinct from each other; follow the seed", () => {
    // are never emitted by the enemy, and are distinct from each other
    {
      const p = params();
      const universe = new Set(Array.from({ length: p.universe }, (_, rank) => rankToValue(p, "outside", 0, rank)));
      const outside = Array.from({ length: 500 }, (_, j) => outsideValue(p, "outside", j));
      expect(new Set(outside).size).toBe(500);
      expect(outside.some((v) => universe.has(v))).toBe(false);
    }
    // follow the seed
    {
      const p = params();
      expect(outsideValue(p, "seed-a", 0)).not.toBe(outsideValue(p, "seed-b", 0));
    }
  });
});

describe("popularity (Skew)", () => {
  it("is nearly flat with no skew; concentrates on one value with high skew, matching the Zipf share", () => {
    // is nearly flat with no skew
    {
      const { live } = play(params({ skew: "low" }, 5000), "flat", 5);
      expect((live.mode()?.count ?? 0) / live.liveTotal).toBeLessThan(0.02); // uniform share is 1/256
    }
    // concentrates on one value with high skew, matching the Zipf share
    {
      const p = params({ skew: "high" }, 50000);
      const { live } = play(p, "skewed", 5);
      let norm = 0;
      for (let k = 1; k <= p.universe; k++) norm += Math.pow(k, -p.skew);
      const expectedShare = 1 / norm; // about 0.22
      const share = (live.mode()?.count ?? 0) / live.liveTotal;
      expect(Math.abs(share - expectedShare)).toBeLessThan(0.02);
      expect(live.mode()?.value).toBe(rankToValue(p, "skewed", 0, 0)); // the rank-1 value
    }
  });
});

describe("deletes (Churn)", () => {
  it("never deletes with no churn; deletes the stated share of events, and only values that are live; leaves ghosts behind", () => {
    // never deletes with no churn
    {
      const { bursts } = play(params(), "no-churn", 5);
      expect(bursts.flat().some((e) => e.op === "delete")).toBe(false);
    }
    // deletes the stated share of events, and only values that are live
    {
      const { bursts } = play(params({ churn: "high" }, 50000), "churn", 5);
      const counts = new Map<number, number>();
      let deletes = 0;
      let total = 0;
      bursts.forEach((burst, turn) => {
        for (const e of burst) {
          const live = counts.get(e.value) ?? 0;
          if (e.op === "delete") {
            expect(live).toBeGreaterThan(0); // never deletes something that is not live
            counts.set(e.value, live - 1);
            if (turn > 0) deletes++;
          } else {
            counts.set(e.value, live + 1);
          }
          if (turn > 0) total++;
        }
      });
      const sigma = Math.sqrt(total * 0.3 * 0.7);
      expect(Math.abs(deletes - total * 0.3)).toBeLessThan(4 * sigma);
    }
    // leaves ghosts behind
    {
      // Ghosts need values with few copies, so use the larger universe where most values appear once.
      const { live } = play(params({ churn: "high", variety: "medium" }, 5000), "ghosts", 5);
      expect(live.ghosts().length).toBeGreaterThan(0);
    }
  });
});

describe("rank-to-value drift", () => {
  const p = params({ drift: "medium" }); // 25% of the top ranks, every 4 turns
  const topRanks = Math.ceil(0.25 * p.universe);

  it("keeps the mapping a bijection at every epoch; reshuffles only the top ranks, among the same values; happens on the stated schedule; and 1 more", () => {
    // keeps the mapping a bijection at every epoch
    {
      for (const epochs of [0, 1, 2, 3]) {
        const values = new Set(Array.from({ length: p.universe }, (_, rank) => rankToValue(p, "drift", epochs, rank)));
        expect(values.size).toBe(p.universe);
      }
    }
    // reshuffles only the top ranks, among the same values
    {
      const before = Array.from({ length: p.universe }, (_, r) => rankToValue(p, "drift", 0, r));
      const after = Array.from({ length: p.universe }, (_, r) => rankToValue(p, "drift", 1, r));
      expect(after.slice(topRanks)).toEqual(before.slice(topRanks)); // lower ranks untouched
      expect(after.slice(0, topRanks)).not.toEqual(before.slice(0, topRanks)); // top ranks moved
      expect([...after.slice(0, topRanks)].sort()).toEqual([...before.slice(0, topRanks)].sort()); // same set of values
    }
    // happens on the stated schedule
    {
      const epochsAfter = (turns: number) => play(p, "schedule", turns).state.driftEpochs;
      expect([1, 2, 3, 4, 5, 7, 8, 9].map(epochsAfter)).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
      expect(play(params(), "none", 8).state.driftEpochs).toBe(0);
    }
    // changes which value is heaviest
    {
      // The rank-1 value before and after a drift event differs for almost every seed.
      const changed = ["a", "b", "c", "d", "e", "f"].filter(
        (seed) => rankToValue(p, seed, 0, 0) !== rankToValue(p, seed, 1, 0),
      );
      expect(changed.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("determinism and state", () => {
  const p = params({ skew: "medium", churn: "medium", growth: "medium", drift: "medium" });

  it("replays identically from the same seed and differs across seeds; never mutates the state it is given, and the state is plain JSON; resumes identically from saved state; and 1 more", () => {
    // replays identically from the same seed and differs across seeds
    {
      expect(play(p, "same", 6).bursts).toEqual(play(p, "same", 6).bursts);
      expect(play(p, "same", 6).bursts).not.toEqual(play(p, "other", 6).bursts);
    }
    // never mutates the state it is given, and the state is plain JSON
    {
      const state = createStream("pure");
      const before = JSON.stringify(state);
      const burst = nextBurst(p, state, new LiveSet());
      expect(JSON.stringify(state)).toBe(before);
      expect(JSON.parse(JSON.stringify(burst.state))).toStrictEqual(burst.state);
    }
    // resumes identically from saved state
    {
      const first = play(p, "resume", 3);
      const state = JSON.parse(JSON.stringify(first.state));
      const live = LiveSet.fromSnapshot(JSON.parse(JSON.stringify(first.live.snapshot())));

      const direct = nextBurst(p, first.state, first.live);
      const resumed = nextBurst(p, state, live);
      expect(resumed.events).toEqual(direct.events);
      expect(resumed.state).toStrictEqual(direct.state);
      expect(live.snapshot()).toStrictEqual(first.live.snapshot());
    }
    // keeps the saved state small at the largest Variety size
    {
      const big = params({ variety: "high" });
      const { state } = play(big, "big", 3);
      expect(JSON.stringify(state).length).toBeLessThan(500);
    }
  });
});
