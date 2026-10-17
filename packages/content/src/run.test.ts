import { describe, expect, it } from "vitest";
import { createRun, groundTruth, legalRunActions, observeRun, STRUCTURE_KINDS, stepRun, turnsTaken, type RunAction, type RunState } from "@pda/engine";
import { balance } from "./balance";
import { buildRunConfig } from "./run";
import { enchantments, parseEnchantments, variantName } from "./enchantments";
import { fusions, parseFusions } from "./fusions";
import { parseUpgrades, upgrades } from "./upgrades";

describe("upgrades.json", () => {
  it("has the five upgrades of the spec, each changing something; rejects an effect that does nothing, an unknown effect and a missing description", () => {
    // has the five upgrades of the spec, each changing something
    {
      expect(Object.keys(upgrades).sort()).toEqual(["capacity", "power", "recovery", "resolve", "slots"]);
      expect(upgrades.capacity?.effect).toEqual({ space: 1024 });
      expect(upgrades.slots?.effect).toEqual({ slots: 1 });
      expect(upgrades.resolve?.effect).toEqual({ maxCertainty: 20 });
      expect(upgrades.recovery?.effect).toEqual({ recovery: 10 });
      expect(upgrades.power?.effect).toEqual({ damagePercent: 10 });
      for (const upgrade of Object.values(upgrades)) expect(Object.keys(upgrade.effect).length).toBeGreaterThan(0);
    }
    // rejects an effect that does nothing, an unknown effect and a missing description
    {
      const ok = { name: "X", summary: "Does a thing.", effect: { space: 1 } };
      expect(() => parseUpgrades({ x: ok })).not.toThrow();
      expect(() => parseUpgrades({ x: { ...ok, effect: {} } })).toThrow();
      expect(() => parseUpgrades({ x: { ...ok, effect: { magic: 1 } } })).toThrow();
      expect(() => parseUpgrades({ x: { name: "X", effect: { space: 1 } } })).toThrow();
    }
  });
});

describe("fusions.json", () => {
  it("has the HyperLogLog recipe: LogLog and Linear Counting make a HyperLogLog; rejects a recipe with one input, a repeated input, a result that is also an input, an unknown structure or no summary", () => {
    // has the HyperLogLog recipe: LogLog and Linear Counting make a HyperLogLog
    {
      expect(fusions.hyperLogLog).toMatchObject({ inputs: ["logLog", "linearCounting"], result: "hyperLogLog" });
      expect(fusions.hyperLogLog?.summary).toMatch(/teaching shortcut/i); // the spec asks the in-game description to say so
    }
    // rejects a recipe with one input, a repeated input, a result that is also an input, an unknown structure or no summary
    {
      const ok = { name: "X", phase: 1, inputs: ["logLog", "linearCounting"], result: "hyperLogLog", summary: "Makes a thing." };
      expect(() => parseFusions({ x: ok })).not.toThrow();
      expect(() => parseFusions({ x: { ...ok, inputs: ["logLog"] } })).toThrow();
      expect(() => parseFusions({ x: { ...ok, inputs: ["logLog", "logLog"] } })).toThrow();
      expect(() => parseFusions({ x: { ...ok, result: "logLog" } })).toThrow();
      expect(() => parseFusions({ x: { ...ok, result: "skipList" } })).toThrow();
      expect(() => parseFusions({ x: { ...ok, summary: undefined } })).toThrow();
    }
  });
});

describe("enchantments.json", () => {
  it("has Seeded, which fits every structure that hashes, and is not yet offered as a reward; has Steady, which fits Count-Min and LogLog, turns them into their named variants, and is offered as a reward; rejects an enchantment that fits nothing, lists a structure twice, transforms one it does not fit, or has no summary; and 1 more", () => {
    // has Seeded, which fits every structure that hashes, and is not yet offered as a reward
    {
      expect(enchantments.seeded).toMatchObject({ name: "Seeded", valid: ["bloomFilter", "countMinSketch", "logLog", "linearCounting", "hyperLogLog"], reward: false });
      expect(enchantments.seeded?.valid).not.toContain("exactMemory"); // nothing is hashed there
    }
    // has Steady, which fits Count-Min and LogLog, turns them into their named variants, and is offered as a reward
    {
      expect(enchantments.steady).toMatchObject({
        name: "Steady",
        valid: ["countMinSketch", "logLog"],
        transforms: { countMinSketch: "Count-Min with Conservative Update", logLog: "SuperLogLog" },
        reward: true,
      });
      expect(enchantments.steady?.summary).toMatch(/10 percent/);
    }
    // has Light, which fits Count-Min and HyperLogLog (not LogLog, which needs many values per register), names no variant, and is offered
    {
      expect(enchantments.light).toMatchObject({ name: "Light", valid: ["countMinSketch", "hyperLogLog"], transforms: {}, reward: true });
      expect(enchantments.light?.valid).not.toContain("logLog");
    }
    // has Fading, which fits only the Bloom Filter, turns it into a Stable Bloom Filter, and is offered as a reward
    {
      expect(enchantments.fading).toMatchObject({ name: "Fading", valid: ["bloomFilter"], transforms: { bloomFilter: "Stable Bloom Filter" }, reward: true });
      expect(variantName("Bloom Filter", "bloomFilter", "fading")).toBe("Stable Bloom Filter");
    }
    // rejects an enchantment that fits nothing, lists a structure twice, transforms one it does not fit, or has no summary
    {
      const ok = { name: "X", phase: 1, summary: "Does a thing.", valid: ["bloomFilter"], transforms: {}, reward: true };
      expect(() => parseEnchantments({ x: ok })).not.toThrow();
      expect(() => parseEnchantments({ x: { ...ok, valid: [] } })).toThrow();
      expect(() => parseEnchantments({ x: { ...ok, valid: ["bloomFilter", "bloomFilter"] } })).toThrow();
      expect(() => parseEnchantments({ x: { ...ok, transforms: { logLog: "Super" } } })).toThrow();
      expect(() => parseEnchantments({ x: { ...ok, summary: undefined } })).toThrow();
      expect(() => parseEnchantments({ x: { ...ok, valid: ["skipList"] } })).toThrow();
    }
    // names a structure by its variant when the enchantment turns it into one, and by its own name otherwise
    {
      expect(variantName("Bloom Filter", "bloomFilter", undefined)).toBe("Bloom Filter");
      expect(variantName("Bloom Filter", "bloomFilter", "seeded")).toBe("Bloom Filter"); // Seeded transforms nothing
      expect(variantName("Bloom Filter", "bloomFilter", "mystery")).toBe("Bloom Filter");
      expect(variantName("Count-Min Sketch", "countMinSketch", "steady")).toBe("Count-Min with Conservative Update");
      expect(variantName("LogLog", "logLog", "steady")).toBe("SuperLogLog");
      expect(variantName("Bloom Filter", "bloomFilter", "steady")).toBe("Bloom Filter"); // it does not fit, so it changes nothing
    }
  });
});

describe("buildRunConfig", () => {
  const config = buildRunConfig({ seed: "run-1" });

  it("builds the encounters of the act in order: five Minions, an Elite, then the Boss, with a rest stop before the Elite; raises the pressure through the act: more non-Low traits and weak points in later tiers; starts with the starting loadout and offers the structures not yet owned, plus every upgrade; and 5 more", () => {
    // builds the encounters of the act in order: five Minions, an Elite, then the Boss, with a rest stop before the Elite
    {
      expect(config.encounters.map((enemy) => enemy.tier)).toEqual(["minion", "minion", "minion", "minion", "minion", "elite", "boss"]);
      expect(config.restBefore).toEqual([5]);
      expect(config.restHeal).toBe(balance.REST_HEAL);
    }
    // raises the pressure through the act: more non-Low traits and weak points in later tiers
    {
      const nonLow = (traits: object) => Object.values(traits).filter((level) => level !== "low").length;
      const [first] = config.encounters;
      const boss = config.encounters.at(-1);
      expect(nonLow(first?.traits ?? {})).toBeLessThanOrEqual(2);
      expect(nonLow(boss?.traits ?? {})).toBe(4);
      expect(boss?.weakPoints).toHaveLength(2);
    }
    // starts with the starting loadout and offers the structures not yet owned, plus every upgrade
    {
      expect(config.loadout).toEqual(balance.STARTING_LOADOUT);
      const structureRewards = config.rewards.filter((r) => r.kind === "structure").map((r) => (r.kind === "structure" ? r.structure : ""));
      const fused = Object.values(fusions).map((fusion) => fusion.result);
      expect(structureRewards.sort()).toEqual(STRUCTURE_KINDS.filter((kind) => !balance.STARTING_LOADOUT.includes(kind) && !fused.includes(kind)).sort());
      expect(structureRewards).not.toContain("hyperLogLog"); // it can only be made, never found
      expect(config.rewards.filter((r) => r.kind === "upgrade").map((r) => r.id).sort()).toEqual(Object.keys(upgrades).map((id) => `upgrade:${id}`).sort());
      for (const reward of config.rewards) expect(reward.weight).toBe(reward.kind === "structure" ? balance.REWARD_WEIGHTS.structure : balance.REWARD_WEIGHTS.upgrade);
      expect(config.rewardChoices).toBe(balance.REWARD_CHOICES);
    }
    // passes the enchantments on, and offers as rewards only those marked as rewards, at the enchantment weight
    {
      expect(config.enchantments).toEqual([
        { id: "seeded", valid: [...(enchantments.seeded?.valid ?? [])] },
        { id: "steady", valid: [...(enchantments.steady?.valid ?? [])] },
        { id: "fading", valid: [...(enchantments.fading?.valid ?? [])] },
        { id: "light", valid: [...(enchantments.light?.valid ?? [])] },
      ]);
      // Steady and Fading are offered; Seeded is not (it only matters against an enemy that does not exist yet).
      expect(config.rewards.filter((r) => r.kind === "enchantment")).toEqual([
        { id: "enchantment:fading", kind: "enchantment", enchantment: "fading", weight: balance.REWARD_WEIGHTS.enchantment },
        { id: "enchantment:light", kind: "enchantment", enchantment: "light", weight: balance.REWARD_WEIGHTS.enchantment },
        { id: "enchantment:steady", kind: "enchantment", enchantment: "steady", weight: balance.REWARD_WEIGHTS.enchantment },
      ]);
      const offered = { ...enchantments, seeded: { ...enchantments.seeded!, reward: true } };
      const withIt = buildRunConfig({ seed: "run-1", enchantmentData: offered });
      expect(withIt.rewards.filter((r) => r.kind === "enchantment").map((r) => r.id)).toEqual(["enchantment:fading", "enchantment:light", "enchantment:seeded", "enchantment:steady"]);
    }
    // passes the recipes on, by id
    {
      expect(config.fusions).toEqual([{ id: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" }]);
    }
    // designs each encounter on its own, so the five Minions are not copies of one another
    {
      const minions = config.encounters.filter((enemy) => enemy.tier === "minion").map((enemy) => JSON.stringify(enemy));
      expect(new Set(minions).size).toBeGreaterThan(1);
    }
    // uses the fight rules of the game, and a different seed gives different enemies
    {
      expect(config.rules).toMatchObject({ startingSpace: balance.STARTING_SPACE, startingCertainty: balance.STARTING_CERTAINTY, startingSlots: balance.STARTING_SLOTS, base: balance.BASE });
      expect(buildRunConfig({ seed: "run-1" })).toEqual(config);
      expect(buildRunConfig({ seed: "run-2" }).encounters).not.toEqual(config.encounters);
    }
    // makes a run the engine accepts, and the player can act in it
    {
      const run: RunState = createRun("run-1", config);
      expect(observeRun(run)).toMatchObject({ phase: "fight", encounter: 0, encounters: 7, certainty: balance.STARTING_CERTAINTY });
      expect(legalRunActions(run).length).toBeGreaterThan(0);
      expect(stepRun(run, { type: "endDeploy" }).state.phase).toBe("fight");
    }
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
    expect(turnsTaken(run)).toBeGreaterThanOrEqual(7 * 2); // at least a stream turn and a strike turn in every fight
  });
});
