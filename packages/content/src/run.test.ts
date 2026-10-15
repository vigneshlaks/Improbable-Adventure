import { describe, expect, it } from "vitest";
import { createRun, groundTruth, legalRunActions, observeRun, STRUCTURE_KINDS, stepRun, turnsTaken, type RunAction, type RunState } from "@pda/engine";
import { balance } from "./balance";
import { buildRunConfig } from "./run";
import { fusions, parseFusions } from "./fusions";
import { parseUpgrades, upgrades } from "./upgrades";

describe("upgrades.json", () => {
  it("has the five upgrades of the spec, each changing something", () => {
    expect(Object.keys(upgrades).sort()).toEqual(["capacity", "power", "recovery", "resolve", "slots"]);
    expect(upgrades.capacity?.effect).toEqual({ space: 1024 });
    expect(upgrades.slots?.effect).toEqual({ slots: 1 });
    expect(upgrades.resolve?.effect).toEqual({ maxCertainty: 20 });
    expect(upgrades.recovery?.effect).toEqual({ recovery: 10 });
    expect(upgrades.power?.effect).toEqual({ damagePercent: 10 });
    for (const upgrade of Object.values(upgrades)) expect(Object.keys(upgrade.effect).length).toBeGreaterThan(0);
  });

  it("rejects an effect that does nothing, an unknown effect and a missing description", () => {
    const ok = { name: "X", summary: "Does a thing.", effect: { space: 1 } };
    expect(() => parseUpgrades({ x: ok })).not.toThrow();
    expect(() => parseUpgrades({ x: { ...ok, effect: {} } })).toThrow();
    expect(() => parseUpgrades({ x: { ...ok, effect: { magic: 1 } } })).toThrow();
    expect(() => parseUpgrades({ x: { name: "X", effect: { space: 1 } } })).toThrow();
  });
});

describe("fusions.json", () => {
  it("has the HyperLogLog recipe: LogLog and Linear Counting make a HyperLogLog", () => {
    expect(fusions.hyperLogLog).toMatchObject({ inputs: ["logLog", "linearCounting"], result: "hyperLogLog" });
    expect(fusions.hyperLogLog?.summary).toMatch(/teaching shortcut/i); // the spec asks the in-game description to say so
  });

  it("rejects a recipe with one input, a repeated input, a result that is also an input, an unknown structure or no summary", () => {
    const ok = { name: "X", phase: 1, inputs: ["logLog", "linearCounting"], result: "hyperLogLog", summary: "Makes a thing." };
    expect(() => parseFusions({ x: ok })).not.toThrow();
    expect(() => parseFusions({ x: { ...ok, inputs: ["logLog"] } })).toThrow();
    expect(() => parseFusions({ x: { ...ok, inputs: ["logLog", "logLog"] } })).toThrow();
    expect(() => parseFusions({ x: { ...ok, result: "logLog" } })).toThrow();
    expect(() => parseFusions({ x: { ...ok, result: "skipList" } })).toThrow();
    expect(() => parseFusions({ x: { ...ok, summary: undefined } })).toThrow();
  });
});

describe("buildRunConfig", () => {
  const config = buildRunConfig({ seed: "run-1" });

  it("builds the encounters of the act in order: five Minions, an Elite, then the Boss, with a rest stop before the Elite", () => {
    expect(config.encounters.map((enemy) => enemy.tier)).toEqual(["minion", "minion", "minion", "minion", "minion", "elite", "boss"]);
    expect(config.restBefore).toEqual([5]);
    expect(config.restHeal).toBe(balance.REST_HEAL);
  });

  it("raises the pressure through the act: more non-Low traits and weak points in later tiers", () => {
    const nonLow = (traits: object) => Object.values(traits).filter((level) => level !== "low").length;
    const [first] = config.encounters;
    const boss = config.encounters.at(-1);
    expect(nonLow(first?.traits ?? {})).toBeLessThanOrEqual(2);
    expect(nonLow(boss?.traits ?? {})).toBe(4);
    expect(boss?.weakPoints).toHaveLength(2);
  });

  it("starts with the starting loadout and offers the structures not yet owned, plus every upgrade", () => {
    expect(config.loadout).toEqual(balance.STARTING_LOADOUT);
    const structureRewards = config.rewards.filter((r) => r.kind === "structure").map((r) => (r.kind === "structure" ? r.structure : ""));
    const fused = Object.values(fusions).map((fusion) => fusion.result);
    expect(structureRewards.sort()).toEqual(STRUCTURE_KINDS.filter((kind) => !balance.STARTING_LOADOUT.includes(kind) && !fused.includes(kind)).sort());
    expect(structureRewards).not.toContain("hyperLogLog"); // it can only be made, never found
    expect(config.rewards.filter((r) => r.kind === "upgrade").map((r) => r.id).sort()).toEqual(Object.keys(upgrades).map((id) => `upgrade:${id}`).sort());
    for (const reward of config.rewards) expect(reward.weight).toBe(reward.kind === "structure" ? balance.REWARD_WEIGHTS.structure : balance.REWARD_WEIGHTS.upgrade);
    expect(config.rewardChoices).toBe(balance.REWARD_CHOICES);
  });

  it("passes the recipes on, by id", () => {
    expect(config.fusions).toEqual([{ id: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" }]);
  });

  it("designs each encounter on its own, so the five Minions are not copies of one another", () => {
    const minions = config.encounters.filter((enemy) => enemy.tier === "minion").map((enemy) => JSON.stringify(enemy));
    expect(new Set(minions).size).toBeGreaterThan(1);
  });

  it("uses the fight rules of the game, and a different seed gives different enemies", () => {
    expect(config.rules).toMatchObject({ startingSpace: balance.STARTING_SPACE, startingCertainty: balance.STARTING_CERTAINTY, startingSlots: balance.STARTING_SLOTS, base: balance.BASE });
    expect(buildRunConfig({ seed: "run-1" })).toEqual(config);
    expect(buildRunConfig({ seed: "run-2" }).encounters).not.toEqual(config.encounters);
  });

  it("makes a run the engine accepts, and the player can act in it", () => {
    const run: RunState = createRun("run-1", config);
    expect(observeRun(run)).toMatchObject({ phase: "fight", encounter: 0, encounters: 7, certainty: balance.STARTING_CERTAINTY });
    expect(legalRunActions(run).length).toBeGreaterThan(0);
    expect(stepRun(run, { type: "endDeploy" }).state.phase).toBe("fight");
  });
});

describe("a whole act on the real content", () => {
  /** The perfect strike for the open challenge, read from the true answer. */
  function perfectStrike(state: RunState): RunAction {
    const answer = groundTruth(state.fight as NonNullable<RunState["fight"]>).answer;
    if (!answer) throw new Error("no challenge is open");
    if (answer.kind === "presence") return { type: "strikeSubset", targets: answer.real.flatMap((real, position) => (real ? [position] : [])) };
    return { type: "strikeValue", value: answer.kind === "frequency" ? answer.count : answer.distinct };
  }

  it("can be won start to finish, passing through rewards and the rest stop", () => {
    let run = createRun("act-1", buildRunConfig({ seed: "act-1" }));
    const seen = new Set<string>();
    let fused = false;
    for (let guard = 0; guard < 400 && run.phase !== "won" && run.phase !== "lost"; guard++) {
      seen.add(run.phase);
      if (run.phase === "reward") {
        const logLog = (observeRun(run).offers ?? []).findIndex((offer) => offer.id === "structure:logLog");
        run = stepRun(run, { type: "chooseReward", index: Math.max(0, logLog) }).state; // LogLog when offered, so the fusion can happen
      } else if (run.phase === "rest") {
        const fuse = legalRunActions(run).find((action) => action.type === "fuse");
        if (fuse) fused = true;
        run = stepRun(run, fuse ?? { type: "leaveRest" }).state;
      }
      else run = stepRun(run, run.fight?.phase === "strike" ? perfectStrike(run) : { type: "endDeploy" }).state;
    }
    expect(run.phase).toBe("won");
    expect([...seen].sort()).toEqual(["fight", "rest", "reward"]);
    expect(run.encounter).toBe(6);
    expect(fused).toBe(true);
    expect(run.owned).toContain("hyperLogLog");
    expect(run.certainty).toBeGreaterThan(0);
    expect(turnsTaken(run)).toBeGreaterThanOrEqual(7 * 3); // at least a stream turn and two more per fight
  });
});
