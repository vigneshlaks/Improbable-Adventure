import { describe, expect, it } from "vitest";
import { Rng, type RewardView } from "@pda/engine";
import { buildRunConfig } from "@pda/content";
import { getBot } from "./bots";
import type { Bot } from "./bots/types";
import { randomPolicy, sensiblePolicy } from "./runPolicy";
import { playRun } from "./runRunner";

const play = (bot: string, seed: string, maxSteps?: number) =>
  playRun({ config: buildRunConfig({ seed }), seed, bot: getBot(bot), ...(maxSteps !== undefined ? { maxSteps } : {}) });

const structure = (kind: "countMinSketch" | "logLog"): RewardView => ({ id: `structure:${kind}`, kind: "structure", structure: kind });
const upgrade = (id: string): RewardView => ({ id: `upgrade:${id}`, kind: "upgrade", upgrade: id });

describe("the run policies", () => {
  const rng = Rng.fromSeed("policy");

  it("the sensible one takes a new structure before any upgrade, and the upgrades in its own order", () => {
    expect(sensiblePolicy.reward([upgrade("power"), structure("logLog"), upgrade("slots")], rng)).toBe(1);
    expect(sensiblePolicy.reward([upgrade("slots"), upgrade("recovery"), upgrade("power")], rng)).toBe(2);
    expect(sensiblePolicy.reward([upgrade("slots"), upgrade("capacity")], rng)).toBe(1);
    expect(sensiblePolicy.reward([structure("logLog"), structure("countMinSketch")], rng)).toBe(1); // Count-Min first
    expect(sensiblePolicy.reward([upgrade("mystery")], rng)).toBe(0); // anything it does not know is still a legal choice
  });

  it("the sensible one fuses when it can, and otherwise leaves", () => {
    const recipe = { id: "hyperLogLog", inputs: ["logLog", "linearCounting"] as ["logLog", "linearCounting"], result: "hyperLogLog" as const };
    expect(sensiblePolicy.rest([recipe], rng)).toEqual({ type: "fuse", recipeId: "hyperLogLog" });
    expect(sensiblePolicy.rest([], rng)).toEqual({ type: "leaveRest" });
  });

  it("the random one picks every reward and every rest action sometimes", () => {
    const picks = new Set(Array.from({ length: 80 }, () => randomPolicy.reward([upgrade("a"), upgrade("b"), upgrade("c")], rng)));
    expect([...picks].sort()).toEqual([0, 1, 2]);
    const recipe = { id: "hyperLogLog", inputs: ["logLog", "linearCounting"] as ["logLog", "linearCounting"], result: "hyperLogLog" as const };
    const rests = new Set(Array.from({ length: 80 }, () => randomPolicy.rest([recipe], rng).type));
    expect([...rests].sort()).toEqual(["fuse", "leaveRest"]);
  });
});

describe("playRun", () => {
  const oracle = play("oracle", "run-a");

  it("plays a whole act with the Oracle and records how it went", () => {
    expect(oracle).toMatchObject({ bot: "oracle", seed: "run-a", outcome: "won", fightsWon: 7, encounterReached: 6 });
    expect(oracle.fights.map((fight) => fight.tier)).toEqual(["minion", "minion", "minion", "minion", "minion", "elite", "boss"]);
    expect(oracle.fights.every((fight) => fight.outcome === "won")).toBe(true);
    expect(oracle.turns).toBe(oracle.fights.reduce((sum, fight) => sum + fight.turns, 0));
    expect(oracle.certaintyLeft).toBeGreaterThan(0);
  });

  it("records the rewards taken (one after each fight but the last), what was fused, and what ended up owned", () => {
    expect(oracle.rewards).toHaveLength(6);
    expect(oracle.owned.length).toBeGreaterThanOrEqual(4);
    for (const recipe of oracle.fused) expect(oracle.owned).not.toContain(recipe === "hyperLogLog" ? "logLog" : "");
    const upgradesTaken = oracle.rewards.filter((id) => id.startsWith("upgrade:")).length;
    expect(Object.values(oracle.upgrades).reduce((a, b) => a + b, 0)).toBe(upgradesTaken);
  });

  it("is deterministic in the run seed", () => {
    expect(play("greedy", "same")).toEqual(play("greedy", "same"));
    expect(play("greedy", "same")).not.toEqual(play("greedy", "other"));
  });

  it("records a run that was lost, with the encounter it ended on", () => {
    const records = ["x1", "x2", "x3", "x4", "x5", "x6"].map((seed) => play("random", seed));
    const lost = records.find((record) => record.outcome === "lost");
    expect(lost).toBeDefined();
    expect(lost!.fightsWon).toBeLessThan(7);
    expect(lost!.encounterReached).toBe(lost!.fightsWon); // it died in the fight after the last one it won
    expect(lost!.fights.at(-1)?.outcome).toBe("lost");
    expect(lost!.certaintyLeft).toBe(0);
  });

  it("calls a run that never finishes stalled", () => {
    expect(play("greedy", "slow", 25)).toMatchObject({ outcome: "stalled" });
  });

  it("remembers the first structure it deployed, and every kind it deployed once", () => {
    const greedy = play("greedy", "opener");
    expect(greedy.opener).not.toBeNull();
    expect(greedy.deployed).toContain(greedy.opener);
    expect(new Set(greedy.deployed).size).toBe(greedy.deployed.length);
  });

  it("counts strikes, and the wrong ones among them", () => {
    const records = ["s1", "s2", "s3", "s4", "s5"].map((seed) => play("greedy", seed));
    const total = records.reduce((sum, record) => sum + record.strikes.total, 0);
    const wrong = records.reduce((sum, record) => sum + record.strikes.wrong, 0);
    expect(total).toBeGreaterThan(20);
    expect(wrong).toBeGreaterThan(0); // Greedy is wrong about a third of the time
    expect(wrong).toBeLessThan(total);
  });

  it("makes a new fight-level player for each fight", () => {
    let made = 0;
    const counted: Bot = { ...getBot("oracle"), name: "counted", create: () => (made++, getBot("oracle").create()) };
    const record = playRun({ config: buildRunConfig({ seed: "c" }), seed: "c", bot: counted });
    expect(record.outcome).toBe("won");
    expect(made).toBe(7);
  });

  it("takes the opener from the first structure deployed, not the last", () => {
    // Deploys Bloom and then Exact Memory in the first fight, and never again; strikes like Greedy.
    let deployedSoFar = 0;
    const opens: Bot = {
      name: "opens",
      description: "deploys Bloom then Exact Memory once, then plays like Greedy",
      usesTruth: false,
      create: () => {
        const greedy = getBot("greedy").create();
        return (view, rng) => {
          if (view.observation.phase !== "deploy") return greedy(view, rng);
          if (deployedSoFar < 2) {
            const kind = deployedSoFar === 0 ? "bloomFilter" : "exactMemory";
            return { type: "deploy", slot: deployedSoFar++, kind, spaceBits: 1024 };
          }
          return { type: "endDeploy" };
        };
      },
    };
    const record = playRun({ config: buildRunConfig({ seed: "o" }), seed: "o", bot: opens });
    expect(record.opener).toBe("bloomFilter");
    expect(record.deployed).toEqual(["bloomFilter", "exactMemory"]);
  });

  it("names the bot when it takes an action the engine refuses", () => {
    const cheat: Bot = { name: "cheat", description: "cheats", usesTruth: false, create: () => () => ({ type: "strikeValue", value: 5 }) };
    expect(() => playRun({ config: buildRunConfig({ seed: "c" }), seed: "c", bot: cheat })).toThrow(/cheat.*illegal/i);
  });
});
