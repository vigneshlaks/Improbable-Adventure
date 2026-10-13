import { describe, expect, it } from "vitest";
import type { Action, GroundTruth } from "@pda/engine";
import { getBot } from "./bots";
import type { Bot } from "./bots/types";
import { playFight } from "./runner";
import { minion, minionWith } from "./testUtils";

/** A bot built from a function, for testing the runner. */
const scripted = (name: string, act: Bot["create"], usesTruth = false): Bot => ({ name, description: name, usesTruth, create: act });

describe("playFight", () => {
  it("plays a fight to the end and reports what happened", () => {
    const record = playFight({ config: minion("run", "frequency"), seed: "run", bot: getBot("oracle") });
    expect(record).toMatchObject({ bot: "oracle", seed: "run", tier: "minion", outcome: "won", reason: null });
    expect(record.steps).toBeGreaterThan(0);
  });

  it("tallies Certainty lost by cause, and counts wrong strikes", () => {
    // Never deploys, always strikes with a force of 1 (blocked), so the fight ends at the turn limit.
    const futile = scripted("futile", () => (view) => (view.observation.phase === "deploy" ? { type: "endDeploy" } : { type: "strikeValue", value: 1 }));
    const record = playFight({ config: minion("futile", "frequency"), seed: "futile", bot: futile });
    // Minion: attack 3 for 8 turns, 7 blocked strikes at 3 each (turns 2 to 8), and the turn-limit penalty of 20.
    expect(record).toMatchObject({ outcome: "lost", reason: "turnLimit", turns: 8, certaintyLeft: 100 - 24 - 21 - 20 });
    expect(record.certaintyLost).toEqual({ blocked: 21, decoys: 0, misses: 0, attacks: 24, turnLimit: 20 });
    expect(record.strikes).toEqual({ total: 7, wrong: 7 });
  });

  it("records the structures a bot deployed", () => {
    const deployer = scripted("deployer", () => {
      let sent = false;
      return (view) => {
        if (!sent) {
          sent = true;
          return { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 1024 };
        }
        return view.observation.phase === "deploy" ? { type: "endDeploy" } : { type: "strikeValue", value: 1 };
      };
    });
    expect(playFight({ config: minion("dep", "frequency"), seed: "dep", bot: deployer }).deployed).toEqual(["bloomFilter"]);
  });

  it("stops a fight that never ends and calls it stalled", () => {
    const dawdler = scripted("dawdler", () => (view): Action => {
      const remove = view.observation.structures[0];
      return remove ? { type: "remove", slot: remove.slot } : { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 512 };
    });
    const record = playFight({ config: minion("stall", "count"), seed: "stall", bot: dawdler, maxSteps: 50 });
    expect(record).toMatchObject({ outcome: "stalled", steps: 50, reason: null });
  });

  it("keeps the events only when asked", () => {
    const config = minion("events", "count");
    expect(playFight({ config, seed: "events", bot: getBot("oracle") }).events).toBeUndefined();
    const withEvents = playFight({ config, seed: "events", bot: getBot("oracle"), keepEvents: true });
    expect(withEvents.events?.at(-1)?.type).toBe("fightWon");
  });

  it("gives the true answers only to a bot that asks for them", () => {
    const seen: Array<GroundTruth | null> = [];
    const peeker = (usesTruth: boolean) =>
      scripted("peeker", () => (view) => {
        seen.push(view.truth);
        return view.observation.phase === "deploy" ? { type: "endDeploy" } : { type: "strikeValue", value: 1 };
      }, usesTruth);

    playFight({ config: minion("peek", "frequency"), seed: "peek", bot: peeker(false), maxSteps: 12 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((truth) => truth === null)).toBe(true);

    seen.length = 0;
    playFight({ config: minion("peek", "frequency"), seed: "peek", bot: peeker(true), maxSteps: 12 });
    expect(seen.every((truth) => truth !== null)).toBe(true);
  });

  it("reports an illegal action with the bot's name instead of hiding it", () => {
    const cheat = scripted("cheat", () => () => ({ type: "strikeValue", value: 5 })); // no challenge yet
    expect(() => playFight({ config: minion("cheat", "count"), seed: "cheat", bot: cheat })).toThrow(/cheat.*illegal/i);
  });

  it("checks each structure's answer against the truth at every strike", () => {
    // Exact Memory with plenty of room is always right, so every answer holds the truth with no error.
    const exact = scripted("exact", () => {
      let deployed = false;
      return (view) => {
        if (!deployed) {
          deployed = true;
          return { type: "deploy", slot: 0, kind: "exactMemory", spaceBits: 8192 };
        }
        return view.observation.phase === "deploy" ? { type: "endDeploy" } : { type: "strikeValue", value: 1 };
      };
    });
    const record = playFight({ config: minionWith("acc", "frequency", { skew: "high" }), seed: "acc", bot: exact });
    const tally = record.accuracy.exactMemory;
    expect(tally?.answers).toBe(record.strikes.total);
    expect(tally?.covered).toBe(tally?.answers);
    expect(tally?.relativeErrorSum).toBe(0);
    expect(tally?.relativeErrorCount).toBe(tally?.answers);
    expect(tally?.confidenceSum).toBeCloseTo((tally?.answers ?? 0) * 0.95, 10);
    expect(Object.keys(record.accuracy)).toEqual(["exactMemory"]);
  });

  it("has no accuracy to report for a bot that uses no structures", () => {
    expect(playFight({ config: minion("none", "count"), seed: "none", bot: getBot("oracle") }).accuracy).toEqual({});
  });

  it("is deterministic in its seed", () => {
    const a = playFight({ config: minion("det", "presence"), seed: "det", bot: getBot("random") });
    const b = playFight({ config: minion("det", "presence"), seed: "det", bot: getBot("random") });
    expect(a).toEqual(b);
  });
});
