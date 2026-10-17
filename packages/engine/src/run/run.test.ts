import { describe, expect, it } from "vitest";
import { IllegalActionError } from "../combat/types";
import { createRun, legalActions, observeRun, step, turnsTaken } from "./run";
import { play, runConfig, winFight } from "./testUtils";
import type { StructureKind } from "../structures/types";
import type { RunAction, RunState } from "./types";

const start = (seed = "r1", overrides = {}) => createRun(seed, runConfig(overrides));
const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

/** Wins fights and takes the first reward each time, until the run reaches `phase`. */
function until(state: RunState, phase: RunState["phase"], pick = 0): RunState {
  let current = state;
  for (let guard = 0; guard < 40 && current.phase !== phase; guard++) {
    if (current.phase === "fight") current = winFight(current).state;
    else if (current.phase === "reward") current = play(current, { type: "chooseReward", index: pick }).state;
    else if (current.phase === "rest") current = play(current, { type: "leaveRest" }).state;
    else break;
  }
  return current;
}

describe("createRun", () => {
  it("starts the first fight with the configured loadout, Space, slots and Certainty; rejects a run that cannot work", () => {
    // starts the first fight with the configured loadout, Space, slots and Certainty
    {
      const run = start();
      expect(run).toMatchObject({ phase: "fight", encounter: 0, certainty: 100, maxCertainty: 100 });
      expect(run.owned).toEqual(["exactMemory", "reservoirSampling", "bloomFilter", "linearCounting"]);
      expect(run.fight?.config.loadout).toEqual(run.owned);
      expect(observeRun(run)).toMatchObject({ phase: "fight", encounter: 0, encounters: 4, tier: "minion", certainty: 100 });
      expect(observeRun(run).fight).toMatchObject({ spaceFree: 8192, slotsFree: 3 });
    }
    // rejects a run that cannot work
    {
      expect(() => start("x", { encounters: [] })).toThrow(RangeError);
      expect(() => start("x", { rewardChoices: 0 })).toThrow(RangeError);
      expect(() => start("x", { restBefore: [0] })).toThrow(RangeError); // nothing to rest after
      expect(() => start("x", { restBefore: [9] })).toThrow(RangeError);
      expect(() => start("x", { rewards: [{ id: "u", kind: "upgrade", upgrade: "mystery", weight: 1 }] })).toThrow(RangeError);
    }
  });
});

describe("a fight inside a run", () => {
  it("passes fight actions through and keeps the run in its fight phase; carries Certainty from one fight to the next; derives each fight's seed from the run seed, so the same run replays and another differs; and 3 more", () => {
    // passes fight actions through and keeps the run in its fight phase
    {
      const { state, events } = play(start(), { type: "deploy", slot: 0, kind: "exactMemory", spaceBits: 2048 }, { type: "endDeploy" });
      expect(state.phase).toBe("fight");
      expect(types(events)).toEqual(expect.arrayContaining(["structureDeployed", "burstIngested"]));
    }
    // carries Certainty from one fight to the next
    {
      const afterFirst = until(start(), "reward");
      const lost = 100 - afterFirst.certainty;
      expect(lost).toBeGreaterThan(0); // the enemy attacked on turn 1
      const next = play(afterFirst, { type: "chooseReward", index: 0 }).state;
      expect(next.fight?.certainty).toBe(afterFirst.certainty);
      expect(next.encounter).toBe(1);
    }
    // derives each fight's seed from the run seed, so the same run replays and another differs
    {
      const a = winFight(start("same")).state;
      const b = winFight(start("same")).state;
      expect(a).toEqual(b);
      expect(observeRun(start("other")).fight?.weakPoint).toBe(null);
      expect(start("same").fight?.stream).not.toEqual(start("other").fight?.stream);
    }
    // says which tier the encounter is, and how long the act is when each fight starts
    {
      const toElite = until(start("tiers"), "rest"); // two fights in, the rest stop comes before the Elite
      expect(observeRun(toElite).tier).toBe("elite");
      const { events } = play(toElite, { type: "leaveRest" });
      expect(events).toContainEqual({ type: "fightStarted", encounter: 2, encounters: 4, tier: "elite" });
    }
    // gives every encounter its own stream
    {
      const first = start("streams");
      const second = play(until(first, "reward"), { type: "chooseReward", index: 0 }).state;
      expect(second.fight?.stream.seed).not.toBe(first.fight?.stream.seed);
      expect(second.fight?.stream.seed).toMatch(/^streams\/fight\/1$/);
    }
    // ends the run when the fight is lost
    {
      const doomed = createRun("doom", runConfig({ encounters: [{ ...runConfig().encounters[0]!, attack: 500 }, ...runConfig().encounters.slice(1)] }));
      const { state, events } = play(doomed, { type: "endDeploy" });
      expect(state.phase).toBe("lost");
      expect(types(events)).toContain("runLost");
      expect(legalActions(state)).toEqual([]);
      expect(() => step(state, { type: "endDeploy" })).toThrow(IllegalActionError);
    }
  });
});

describe("rewards", () => {
  it("offers the configured number of distinct rewards after a won fight, and does not repeat what is owned; is deterministic in the run seed, and different seeds see different offers; never offers a reward whose weight is zero, and offers fewer when fewer are eligible; and 2 more", () => {
    // offers the configured number of distinct rewards after a won fight, and does not repeat what is owned
    {
      const run = until(start(), "reward");
      const view = observeRun(run);
      expect(view.phase).toBe("reward");
      expect(view.offers).toHaveLength(3);
      expect(new Set(view.offers?.map((o) => o.id)).size).toBe(3);
      expect(legalActions(run)).toEqual([0, 1, 2].map((index) => ({ type: "chooseReward", index })));

      const countMin = (view.offers ?? []).findIndex((o) => o.id === "structure:countMinSketch");
      if (countMin >= 0) {
        const next = play(run, { type: "chooseReward", index: countMin }).state;
        expect(next.owned).toContain("countMinSketch");
        expect(next.fight?.config.loadout).toContain("countMinSketch");
      }
    }
    // is deterministic in the run seed, and different seeds see different offers
    {
      const offers = (seed: string) => observeRun(until(start(seed), "reward")).offers?.map((o) => o.id).join();
      expect(offers("a")).toBe(offers("a"));
      expect(new Set(["a", "b", "c", "d", "e", "f"].map(offers)).size).toBeGreaterThan(1);
    }
    // never offers a reward whose weight is zero, and offers fewer when fewer are eligible
    {
      const only = runConfig({
        rewards: [
          { id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 },
          { id: "upgrade:slots", kind: "upgrade", upgrade: "slots", weight: 0 },
        ],
      });
      const view = observeRun(until(createRun("w", only), "reward"));
      expect(view.offers?.map((o) => o.id)).toEqual(["upgrade:power"]);
    }
    // skips the reward phase when nothing is left to offer
    {
      const nothing = runConfig({ rewards: [{ id: "structure:linearCounting", kind: "structure", structure: "linearCounting", weight: 1 }] });
      const run = winFight(createRun("none", nothing)).state; // already owned, so not eligible
      expect(run.phase).toBe("fight");
      expect(run.encounter).toBe(1);
    }
    // refuses a reward action out of turn or out of range
    {
      expect(() => step(start(), { type: "chooseReward", index: 0 })).toThrow(IllegalActionError);
      const run = until(start(), "reward");
      expect(() => step(run, { type: "chooseReward", index: 3 })).toThrow(IllegalActionError);
      expect(() => step(run, { type: "endDeploy" })).toThrow(IllegalActionError);
    }
  });
});

describe("upgrades", () => {
  /** Takes the named upgrade at the first reward (the config offers only that one), then reads the next fight. */
  const take = (upgrade: "capacity" | "slots" | "resolve" | "recovery" | "power", overrides = {}) => {
    const config = runConfig({
      rewards: [{ id: `upgrade:${upgrade}`, kind: "upgrade", upgrade, weight: 1 }],
      ...overrides,
    });
    const reward = until(createRun("up", config), "reward");
    return { reward, next: play(reward, { type: "chooseReward", index: 0 }).state };
  };

  it("Capacity adds Space and Slots adds a slot, in every later fight; Resolve raises the maximum and the current Certainty; Recovery restores Certainty after each fight, never above the maximum; and 2 more", () => {
    // Capacity adds Space and Slots adds a slot, in every later fight
    {
      expect(observeRun(take("capacity").next).fight?.spaceFree).toBe(8192 + 1024);
      expect(observeRun(take("slots").next).fight?.slotsFree).toBe(4);
    }
    // Resolve raises the maximum and the current Certainty
    {
      const { reward, next } = take("resolve");
      expect(next.maxCertainty).toBe(120);
      expect(next.certainty).toBe(reward.certainty + 20);
    }
    // Recovery restores Certainty after each fight, never above the maximum
    {
      const { reward, next } = take("recovery");
      const after = until(next, "reward");
      const plain = until(createRun("up", runConfig({ rewards: [{ id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 }] })), "reward");
      expect(reward.certainty).toBeLessThanOrEqual(100);
      expect(after.certainty).toBeLessThanOrEqual(after.maxCertainty);
      // Two fights each cost Certainty; Recovery gives back 10 after the second (and the first fight's reward comes before it).
      const baseline = until(play(plain, { type: "chooseReward", index: 0 }).state, "reward");
      expect(after.certainty).toBe(Math.min(100, baseline.certainty + 10));
    }
    // Power scales strike damage
    {
      const { next } = take("power");
      const events = winFight(next).events;
      const strike = events.find((e) => e.type === "strikeResolved") as { damage: number } | undefined;
      expect(strike?.damage).toBeCloseTo(22, 6); // a perfect Frequency strike is BASE 20, plus 10 percent
    }
    // stacks when the same upgrade is taken twice
    {
      const config = runConfig({ rewards: [{ id: "upgrade:capacity", kind: "upgrade", upgrade: "capacity", weight: 1 }] });
      let run = createRun("stack", config);
      run = play(until(run, "reward"), { type: "chooseReward", index: 0 }).state;
      run = play(until(run, "reward"), { type: "chooseReward", index: 0 }, { type: "leaveRest" }).state; // a rest stop follows the second fight
      expect(run.upgrades).toEqual({ capacity: 2 });
      expect(run.fight?.config.rules.startingSpace).toBe(8192 + 2048);
    }
  });
});

describe("the rest stop", () => {
  it("comes before the configured encounter, heals up to the maximum, and ends when the player leaves", () => {
    const config = runConfig({ rewards: [{ id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 }] });
    let run = createRun("rest", config);
    run = play(until(run, "reward"), { type: "chooseReward", index: 0 }).state; // fight 1 -> fight 2
    const certaintyBefore = (until(run, "reward")).certainty;
    const afterReward = play(until(run, "reward"), { type: "chooseReward", index: 0 });
    expect(afterReward.state.phase).toBe("rest");
    expect(types(afterReward.events)).toContain("restStarted");
    expect(afterReward.state.certainty).toBe(Math.min(100, certaintyBefore + 30));
    expect(legalActions(afterReward.state)).toEqual([{ type: "leaveRest" }]);
    const left = play(afterReward.state, { type: "leaveRest" }).state;
    expect(left).toMatchObject({ phase: "fight", encounter: 2 });
    expect(() => step(afterReward.state, { type: "endDeploy" })).toThrow(IllegalActionError);
  });
});

describe("a whole run", () => {
  it("is won by winning the last encounter, with no reward after it, and counts the turns; survives JSON unchanged, never changes the state it was given, and continues the same", () => {
    // is won by winning the last encounter, with no reward after it, and counts the turns
    {
      const final = until(start(), "won");
      expect(final.phase).toBe("won");
      expect(final.encounter).toBe(3);
      expect(turnsTaken(final)).toBe(8); // each test fight takes 2 turns
      expect(legalActions(final)).toEqual([]);
    }
    // survives JSON unchanged, never changes the state it was given, and continues the same
    {
      const run = until(start(), "reward");
      const frozen = JSON.stringify(run);
      const next = play(run, { type: "chooseReward", index: 1 }).state;
      expect(JSON.stringify(run)).toBe(frozen);
      const revived = JSON.parse(frozen) as RunState;
      expect(play(revived, { type: "chooseReward", index: 1 }).state).toEqual(next);
    }
  });
});

describe("fusions at the rest stop", () => {
  /** A run that offers LogLog at its first reward, takes it, and arrives at the rest stop (before encounter 2). */
  function restWith(logLog: boolean, overrides = {}) {
    const rewards = [
      { id: "structure:logLog", kind: "structure" as const, structure: "logLog" as const, weight: 1 },
      { id: "upgrade:power", kind: "upgrade" as const, upgrade: "power", weight: 1 },
    ];
    let run = createRun("fuse", runConfig({ rewards, ...overrides }));
    for (let reward = 0; reward < 2; reward++) {
      run = until(run, "reward");
      const options = observeRun(run).offers ?? [];
      const wanted = logLog && reward === 0 ? "structure:logLog" : "upgrade:power";
      run = play(run, { type: "chooseReward", index: Math.max(0, options.findIndex((o) => o.id === wanted)) }).state;
    }
    return run;
  }

  it("offers a fusion whose inputs are all owned, next to leaving; consumes the inputs and gives the result, which the next fight can deploy; refuses a fusion out of turn, with an unknown recipe, or without the inputs; and 3 more", () => {
    // offers a fusion whose inputs are all owned, next to leaving
    {
      const rest = restWith(true);
      expect(rest.phase).toBe("rest");
      expect(legalActions(rest)).toEqual([{ type: "fuse", recipeId: "hyperLogLog" }, { type: "leaveRest" }]);
      expect(observeRun(rest).fusions).toEqual([{ id: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" }]);
      expect(legalActions(restWith(false))).toEqual([{ type: "leaveRest" }]); // LogLog was never taken
    }
    // consumes the inputs and gives the result, which the next fight can deploy
    {
      const { state, events } = play(restWith(true), { type: "fuse", recipeId: "hyperLogLog" });
      expect(state.phase).toBe("rest"); // fusing does not end the rest stop
      expect(state.owned).toEqual(["exactMemory", "reservoirSampling", "bloomFilter", "hyperLogLog"]);
      expect(events).toContainEqual({ type: "fused", recipeId: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" });
      expect(legalActions(state)).toEqual([{ type: "leaveRest" }]); // the inputs are gone
      const fight = play(state, { type: "leaveRest" }).state;
      expect(fight.fight?.config.loadout).toContain("hyperLogLog");
      expect(fight.fight?.config.loadout).not.toContain("logLog");
      expect(legalActions(fight).some((a) => a.type === "deploy" && a.kind === "hyperLogLog")).toBe(true);
    }
    // refuses a fusion out of turn, with an unknown recipe, or without the inputs
    {
      expect(() => step(start(), { type: "fuse", recipeId: "hyperLogLog" })).toThrow(IllegalActionError); // in a fight
      expect(() => step(restWith(true), { type: "fuse", recipeId: "mystery" })).toThrow(IllegalActionError);
      expect(() => step(restWith(false), { type: "fuse", recipeId: "hyperLogLog" })).toThrow(IllegalActionError);
      const fused = play(restWith(true), { type: "fuse", recipeId: "hyperLogLog" }).state;
      expect(() => step(fused, { type: "fuse", recipeId: "hyperLogLog" })).toThrow(IllegalActionError); // already used up
    }
    // does not offer a consumed structure as a reward again
    {
      const fused = play(restWith(true), { type: "fuse", recipeId: "hyperLogLog" }, { type: "leaveRest" }).state;
      expect(fused.consumed).toEqual(["logLog", "linearCounting"]);
      const offers = observeRun(until(fused, "reward")).offers ?? [];
      expect(offers.some((o) => o.kind === "structure" && o.structure === "logLog")).toBe(false);
    }
    // does not offer a fusion whose result is already owned
    {
      const owned = until(createRun("dup", runConfig({ loadout: ["exactMemory", "logLog", "linearCounting", "hyperLogLog"] })), "rest");
      expect(owned.phase).toBe("rest");
      expect(legalActions(owned)).toEqual([{ type: "leaveRest" }]);
    }
    // rejects a recipe that cannot work
    {
      expect(() => start("x", { fusions: [{ id: "a", inputs: ["logLog", "logLog"], result: "hyperLogLog" }] })).toThrow(RangeError);
      expect(() => start("x", { fusions: [{ id: "a", inputs: ["logLog", "linearCounting"], result: "logLog" }] })).toThrow(RangeError);
      expect(() => start("x", { fusions: [{ id: "a", inputs: ["logLog"], result: "hyperLogLog" }] })).toThrow(RangeError);
      const twice = { id: "a", inputs: ["logLog", "linearCounting"] as const, result: "hyperLogLog" as const };
      expect(() => start("x", { fusions: [twice, twice] })).toThrow(RangeError);
    }
  });
});

describe("enchantments", () => {
  const seeded = { id: "enchantment:seeded", kind: "enchantment" as const, enchantment: "seeded", weight: 1 };
  const other = { id: "enchantment:other", kind: "enchantment" as const, enchantment: "other", weight: 1 };

  /** A run that offers only the given enchantments, takes the first offer each time, and stops at the rest stop (before encounter 2). */
  function atRest(rewards = [seeded], overrides = {}) {
    return until(createRun("ench", runConfig({ rewards, ...overrides })), "rest");
  }
  const enchant = (enchantmentId: string, kind: StructureKind): RunAction => ({ type: "enchant", enchantmentId, kind });

  it("is offered as a reward, and taking it puts it in the inventory without attaching it; keeps every enchantment taken, even the same one twice; lists, at the rest stop, each owned structure an enchantment from the inventory fits; and 8 more", () => {
    // is offered as a reward, and taking it puts it in the inventory without attaching it
    {
      const reward = until(createRun("ench", runConfig({ rewards: [seeded] })), "reward");
      expect(observeRun(reward).offers).toEqual([{ id: "enchantment:seeded", kind: "enchantment", enchantment: "seeded" }]);
      const taken = play(reward, { type: "chooseReward", index: 0 }).state;
      expect(taken.enchantments).toEqual(["seeded"]);
      expect(taken.attached).toEqual({});
    }
    // keeps every enchantment taken, even the same one twice
    {
      const rest = atRest(); // two fights, two rewards
      expect(rest.enchantments).toEqual(["seeded", "seeded"]);
      expect(observeRun(rest)).toMatchObject({ enchantments: ["seeded", "seeded"], attached: {} });
    }
    // lists, at the rest stop, each owned structure an enchantment from the inventory fits
    {
      const rest = atRest();
      const options = observeRun(rest).enchantable;
      // Seeded fits Bloom Filter and Linear Counting here; the other owned structures are not hashed.
      expect(options).toEqual([
        { enchantmentId: "seeded", kind: "bloomFilter" },
        { enchantmentId: "seeded", kind: "linearCounting" },
      ]);
      expect(legalActions(rest)).toEqual([enchant("seeded", "bloomFilter"), enchant("seeded", "linearCounting"), { type: "leaveRest" }]);
    }
    // attaches to a structure, uses the enchantment up from the inventory, and the next fight builds the structure enchanted
    {
      const { state, events } = play(atRest(), enchant("seeded", "bloomFilter"));
      expect(state.phase).toBe("rest"); // attaching does not end the rest stop
      expect(state.attached).toEqual({ bloomFilter: "seeded" });
      expect(state.enchantments).toEqual(["seeded"]); // one of the two is used
      expect(events).toContainEqual({ type: "enchanted", enchantmentId: "seeded", kind: "bloomFilter", replaced: null });

      const fight = play(state, { type: "leaveRest" }).state;
      expect(fight.fight?.config.enchantments).toEqual({ bloomFilter: "seeded" });
      const deployed = play(fight, { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 1024 }).state;
      expect(observeRun(deployed).fight?.structures[0]).toMatchObject({ kind: "bloomFilter", enchantment: "seeded" });
    }
    // holds one enchantment per structure: attaching another returns the first to the inventory
    {
      const both = atRest([seeded, other]); // offers both each time; the first offer is taken
      const withBoth = { ...both, enchantments: ["seeded", "other"] };
      let state = play(withBoth, enchant("seeded", "bloomFilter")).state;
      expect(state.attached).toEqual({ bloomFilter: "seeded" });
      state = play(state, enchant("other", "bloomFilter")).state;
      expect(state.attached).toEqual({ bloomFilter: "other" });
      expect(state.enchantments).toEqual(["seeded"]);
      expect(play(withBoth, enchant("seeded", "bloomFilter"), enchant("other", "bloomFilter")).events.at(-1)).toEqual({
        type: "enchanted",
        enchantmentId: "other",
        kind: "bloomFilter",
        replaced: "seeded",
      });
    }
    // moves an attached enchantment to another structure
    {
      let state = play(atRest(), enchant("seeded", "bloomFilter")).state;
      state = { ...state, enchantments: [] }; // nothing left in the inventory, so only the attached one can be moved
      expect(legalActions(state)).toContainEqual(enchant("seeded", "linearCounting"));
      state = play(state, enchant("seeded", "linearCounting")).state;
      expect(state.attached).toEqual({ linearCounting: "seeded" });
      expect(state.enchantments).toEqual([]);
    }
    // returns the enchantments of fused structures to the inventory, and the result starts without one
    {
      const rewards = [{ id: "structure:logLog", kind: "structure" as const, structure: "logLog" as const, weight: 1 }, seeded];
      let rest = createRun("fuse-ench", runConfig({ rewards }));
      rest = until(rest, "reward");
      rest = play(rest, { type: "chooseReward", index: (observeRun(rest).offers ?? []).findIndex((o) => o.id === "structure:logLog") }).state;
      rest = until(rest, "reward");
      rest = play(rest, { type: "chooseReward", index: (observeRun(rest).offers ?? []).findIndex((o) => o.id === "enchantment:seeded") }).state;
      expect(rest.phase).toBe("rest");
      const fused = play(rest, enchant("seeded", "logLog"), { type: "fuse", recipeId: "hyperLogLog" }).state;
      expect(fused.attached).toEqual({});
      expect(fused.enchantments).toEqual(["seeded"]);
      expect(fused.owned).toContain("hyperLogLog");
    }
    // refuses an enchant out of turn, for a structure not owned or not fitting, an enchantment not held, or one already there
    {
      expect(() => step(start(), enchant("seeded", "bloomFilter"))).toThrow(IllegalActionError); // in a fight
      const rest = atRest();
      expect(() => step(rest, enchant("seeded", "countMinSketch"))).toThrow(IllegalActionError); // not owned
      expect(() => step(rest, enchant("seeded", "exactMemory"))).toThrow(IllegalActionError); // does not fit
      expect(() => step(rest, enchant("mystery", "bloomFilter"))).toThrow(IllegalActionError); // unknown
      expect(() => step(rest, enchant("other", "bloomFilter"))).toThrow(IllegalActionError); // not held
      const attached = play(rest, enchant("seeded", "bloomFilter")).state;
      expect(() => step(attached, enchant("seeded", "bloomFilter"))).toThrow(IllegalActionError); // already there
    }
    // is not a repeat of the same offer: rewards of other kinds still work alongside it
    {
      const mixed = createRun("mixed", runConfig({ rewards: [seeded, { id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 }] }));
      expect(new Set((observeRun(until(mixed, "reward")).offers ?? []).map((o) => o.kind))).toEqual(new Set(["enchantment", "upgrade"]));
    }
    // rejects a config whose reward names an enchantment that does not exist, or one that fits nothing
    {
      expect(() => start("x", { rewards: [{ id: "enchantment:mystery", kind: "enchantment", enchantment: "mystery", weight: 1 }] })).toThrow(RangeError);
      expect(() => start("x", { enchantments: [{ id: "a", valid: [] }] })).toThrow(RangeError);
      expect(() => start("x", { enchantments: [{ id: "a", valid: ["bloomFilter"] }, { id: "a", valid: ["bloomFilter"] }] })).toThrow(RangeError);
    }
    // survives JSON unchanged with enchantments attached
    {
      const state = play(atRest(), enchant("seeded", "bloomFilter")).state;
      const revived = JSON.parse(JSON.stringify(state)) as RunState;
      expect(play(revived, { type: "leaveRest" }).state).toEqual(play(state, { type: "leaveRest" }).state);
    }
  });
});
