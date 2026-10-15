import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { buildFightConfig, type TierName } from "@pda/content";
import {
  createFight,
  observe,
  Rng,
  STRUCTURE_KINDS,
  type Action,
  type FightConfig,
  type FightState,
  type StreamTraits,
  type WeakPoint,
} from "@pda/engine";
import { BOTS, getBot } from "./bots";
import type { Bot, BotView } from "./bots/types";
import { makeView, playFight, type FightRecord } from "./runner";
import { minion } from "./testUtils";

const CALM: StreamTraits = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low" };
const WEAK_POINTS: WeakPoint[] = ["presence", "frequency", "count"];

/** A fight with chosen traits and loadout, with the weak point hidden as in a real fight. */
function fightWith(traits: Partial<StreamTraits>, weakPoint: WeakPoint = "frequency", loadout: FightConfig["loadout"] = [...STRUCTURE_KINDS]): { config: FightConfig; state: FightState } {
  const base = buildFightConfig({ seed: "traits", tier: "minion", loadout });
  const config = { ...base, enemy: { ...base.enemy, traits: { ...CALM, ...traits }, weakPoints: [weakPoint] } };
  return { config, state: createFight("traits", config) };
}

/** The action a bot takes first. */
function firstAction(bot: Bot, state: FightState, config: FightConfig): Action {
  return bot.create()(makeView(state, config, bot), Rng.fromSeed("first"));
}

/** Runs a bot while recording every (view, action) pair, to check its decisions. */
function observed(bot: Bot, config: FightConfig, seed: string) {
  const decisions: Array<{ view: BotView; action: Action }> = [];
  const spy: Bot = {
    ...bot,
    create: () => {
      const player = bot.create();
      return (view, rng) => {
        const action = player(view, rng);
        decisions.push({ view, action });
        return action;
      };
    },
  };
  return { record: playFight({ config, seed, bot: spy }), decisions };
}

const winRate = (records: FightRecord[]) => records.filter((r) => r.outcome === "won").length / records.length;
const play = (bot: string, tier: TierName, seeds: number, loadout?: FightConfig["loadout"]): FightRecord[] =>
  Array.from({ length: seeds }, (_, i) => {
    const seed = `${bot}-${tier}-${i}`;
    return playFight({ config: buildFightConfig({ seed, tier, ...(loadout ? { loadout } : {}) }), seed, bot: getBot(bot) });
  });

describe("the bots", () => {
  it("are the five the spec names, and only the Oracle may see the truth", () => {
    expect(Object.keys(BOTS).sort()).toEqual(["cautious", "greedy", "oracle", "prober", "random"]);
    expect(Object.values(BOTS).filter((bot) => bot.usesTruth).map((bot) => bot.name)).toEqual(["oracle"]);
    for (const bot of Object.values(BOTS)) expect(bot.description.length).toBeGreaterThan(10);
  });

  it("rejects an unknown bot name", () => {
    expect(() => getBot("clever")).toThrow(/random, greedy, prober, cautious, oracle/);
  });

  it("never takes an action the engine refuses, for any bot, in every tier and for every weak point", () => {
    eachCase(Object.keys(BOTS).map((name) => [name, name] as const), (name) => {
      for (const tier of ["minion", "elite", "boss"] as const) {
        for (let i = 0; i < 6; i++) {
          const seed = `legal-${name}-${tier}-${i}`;
          const config = buildFightConfig({ seed, tier, loadout: [...STRUCTURE_KINDS] });
          const forced: FightConfig = { ...config, enemy: { ...config.enemy, weakPoints: [WEAK_POINTS[i % 3] as WeakPoint] } };
          // playFight throws if the bot ever returns an illegal action.
          const record = playFight({ config: forced, seed, bot: getBot(name), maxSteps: 3000 });
          expect(["won", "lost", "stalled"]).toContain(record.outcome);
        }
      }
    });
  });

  it("has every bot play the same fight the same way twice", () => {
    eachCase(Object.keys(BOTS).map((name) => [name, name] as const), (name) => {
      const config = minion("same", "presence");
      expect(playFight({ config, seed: "same", bot: getBot(name) })).toEqual(playFight({ config, seed: "same", bot: getBot(name) }));
    });
  });
});

describe("Oracle", () => {
  it("wins a Minion fight on turn 3 without losing Certainty to its own strikes", () => {
    for (const weakPoint of WEAK_POINTS) {
      for (let i = 0; i < 5; i++) {
        const record = playFight({ config: minion(`oracle-${i}`, weakPoint), seed: `oracle-${i}`, bot: getBot("oracle") });
        expect(record).toMatchObject({ outcome: "won", turns: 3, certaintyLeft: 94 });
        expect(record.certaintyLost).toMatchObject({ blocked: 0, decoys: 0, misses: 0 });
        expect(record.deployed).toEqual([]);
      }
    }
  });

  it("wins at least 95 percent of fights in every tier", () => {
    eachCase((["minion", "elite", "boss"] as const).map((tier) => [tier, tier] as const), (tier) => {
      expect(winRate(play("oracle", tier, 40))).toBeGreaterThanOrEqual(0.95);
    });
  });
});

describe("Random", () => {
  it("wins less often than a competent bot or the Oracle", () => {
    const random = winRate(play("random", "minion", 60, [...STRUCTURE_KINDS]));
    expect(random).toBeLessThan(winRate(play("greedy", "minion", 60, [...STRUCTURE_KINDS])));
    expect(random).toBeLessThan(winRate(play("oracle", "minion", 60, [...STRUCTURE_KINDS])));
  });
});

describe("Greedy", () => {
  it("deploys the structure that suits the most likely weak point, first", () => {
    const skewed = fightWith({ skew: "high" });
    expect(firstAction(getBot("greedy"), skewed.state, skewed.config)).toMatchObject({ type: "deploy", kind: "countMinSketch" });

    const varied = fightWith({ variety: "high" });
    expect(firstAction(getBot("greedy"), varied.state, varied.config)).toMatchObject({ type: "deploy", kind: "logLog" });

    const small = fightWith({ variety: "medium" });
    expect(firstAction(getBot("greedy"), small.state, small.config)).toMatchObject({ type: "deploy", kind: "linearCounting" });

    const churning = fightWith({ churn: "high" });
    expect(firstAction(getBot("greedy"), churning.state, churning.config)).toMatchObject({ type: "deploy", kind: "bloomFilter" });
  });

  it("falls back to what it owns when the best match is missing", () => {
    const { config, state } = fightWith({ skew: "high" }, "frequency", ["exactMemory", "reservoirSampling", "bloomFilter"]);
    expect(firstAction(getBot("greedy"), state, config)).toMatchObject({ type: "deploy", kind: "exactMemory" });
  });

  it("covers its two best guesses, splitting the Space, then lets the stream arrive", () => {
    const { config } = fightWith({ skew: "high" });
    const { decisions } = observed(getBot("greedy"), config, "split");
    const firstTurn = decisions.filter((d) => d.view.observation.turn === 1).map((d) => d.action);
    expect(firstTurn).toEqual([
      { type: "deploy", slot: 0, kind: "countMinSketch", spaceBits: 4096 },
      { type: "deploy", slot: 1, kind: "bloomFilter", spaceBits: 4096 },
      { type: "endDeploy" },
    ]);
  });

  it("changes its structures when the weak point turns out to be something else", () => {
    // The traits point at Frequency but the weak point is Count.
    let adapted = 0;
    for (let i = 0; i < 6; i++) {
      const { config } = fightWith({ skew: "high" }, "count");
      const { record } = observed(getBot("greedy"), config, `adapt-${i}`);
      if (record.deployed.some((kind) => kind === "logLog" || kind === "linearCounting")) adapted++;
    }
    expect(adapted).toBe(6);
  });

  it("strikes at an estimate, without needing the true count", () => {
    const config = minion("estimate", "frequency");
    const { decisions } = observed(getBot("greedy"), config, "estimate");
    const strikes = decisions.filter((d) => d.action.type === "strikeValue");
    expect(strikes.length).toBeGreaterThan(0);
    for (const { view, action } of strikes) {
      const cms = view.observation.structures.find((s) => s.kind === "countMinSketch");
      if (cms?.answer && action.type === "strikeValue") expect(action.value).toBe(Math.round(cms.answer.estimate as number));
    }
  });
});

describe("Prober", () => {
  it("opens with Reservoir Sampling", () => {
    const { config, state } = fightWith({ skew: "high" });
    expect(firstAction(getBot("prober"), state, config)).toEqual({ type: "deploy", slot: 0, kind: "reservoirSampling", spaceBits: 3276 });
  });

  it("then commits to what the traits suggest, with the Space that is left", () => {
    const { config } = fightWith({ skew: "high" });
    const { decisions } = observed(getBot("prober"), config, "commit");
    const firstTurn = decisions.filter((d) => d.view.observation.turn === 1).map((d) => d.action);
    expect(firstTurn[0]).toMatchObject({ kind: "reservoirSampling" });
    expect(firstTurn[1]).toMatchObject({ type: "deploy", kind: "countMinSketch" });
    expect(firstTurn.at(-1)).toEqual({ type: "endDeploy" });
  });

  it("is never left without an answer, because the Reservoir can answer any question", () => {
    for (const weakPoint of WEAK_POINTS) {
      const { decisions } = observed(getBot("prober"), minion(`probe-${weakPoint}`, weakPoint), `probe-${weakPoint}`);
      const strikes = decisions.filter((d) => d.view.observation.phase === "strike");
      expect(strikes.length).toBeGreaterThan(0);
      for (const { view } of strikes) expect(view.observation.structures.some((s) => s.answer !== null)).toBe(true);
    }
  });
});

describe("Cautious", () => {
  it("strikes only Presence targets that two structures flagged", () => {
    let presenceStrikes = 0;
    for (let i = 0; i < 12; i++) {
      const config = minion(`cautious-${i}`, "presence");
      const { decisions } = observed(getBot("cautious"), config, `cautious-${i}`);
      for (const { view, action } of decisions) {
        const challenge = view.observation.challenge;
        if (action.type !== "strikeSubset" || challenge?.kind !== "presence") continue;
        presenceStrikes++;
        const votes = new Map<number, number>();
        for (const s of view.observation.structures) {
          if (Array.isArray(s.answer?.estimate)) {
            for (const target of s.answer.estimate) votes.set(target, (votes.get(target) ?? 0) + 1);
          }
        }
        for (const position of action.targets) {
          expect(votes.get(challenge.targets[position] as number) ?? 0).toBeGreaterThanOrEqual(2);
        }
      }
    }
    expect(presenceStrikes).toBeGreaterThan(0);
  });

  it("is never blocked on a Frequency fight, because it strikes at the upper bound", () => {
    // High Skew makes Cautious deploy a Count-Min sketch on turn 1, so its upper bound has the full history.
    const { config } = fightWith({ skew: "high" }, "frequency");
    for (let i = 0; i < 20; i++) {
      const record = playFight({ config, seed: `safe-${i}`, bot: getBot("cautious") });
      expect(record.certaintyLost.blocked).toBe(0);
    }
  });

  it("deploys two structures for the same weak point so answers can be cross-checked", () => {
    const { config } = fightWith({ churn: "high" });
    const { decisions } = observed(getBot("cautious"), config, "pair");
    const deploys = decisions.filter((d) => d.action.type === "deploy" && d.view.observation.turn === 1).map((d) => (d.action as { kind: string }).kind);
    expect(deploys.slice(0, 2)).toEqual(["bloomFilter", "exactMemory"]);
  });
});

describe("what the bots can see", () => {
  it("never reads the true answers unless they are the Oracle", () => {
    const config = minion("blind", "frequency");
    for (const name of ["random", "greedy", "prober", "cautious"]) {
      const { decisions } = observed(getBot(name), config, "blind");
      expect(decisions.every((d) => d.view.truth === null)).toBe(true);
    }
    expect(observe(createFight("blind", config))).not.toHaveProperty("truth");
  });
});
