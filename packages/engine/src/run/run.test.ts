import { describe, expect, it } from "vitest";
import { IllegalActionError } from "../combat/types";
import { createRun, legalActions, observeRun, step, turnsTaken } from "./run";
import { play, runConfig, winFight } from "./testUtils";
import type { RunState } from "./types";

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
  it("starts the first fight with the configured loadout, Space, slots and Certainty", () => {
    const run = start();
    expect(run).toMatchObject({ phase: "fight", encounter: 0, certainty: 100, maxCertainty: 100 });
    expect(run.owned).toEqual(["exactMemory", "reservoirSampling", "bloomFilter", "linearCounting"]);
    expect(run.fight?.config.loadout).toEqual(run.owned);
    expect(observeRun(run)).toMatchObject({ phase: "fight", encounter: 0, encounters: 4, certainty: 100 });
    expect(observeRun(run).fight).toMatchObject({ spaceFree: 8192, slotsFree: 3 });
  });

  it("rejects a run that cannot work", () => {
    expect(() => start("x", { encounters: [] })).toThrow(RangeError);
    expect(() => start("x", { rewardChoices: 0 })).toThrow(RangeError);
    expect(() => start("x", { restBefore: [0] })).toThrow(RangeError); // nothing to rest after
    expect(() => start("x", { restBefore: [9] })).toThrow(RangeError);
    expect(() => start("x", { rewards: [{ id: "u", kind: "upgrade", upgrade: "mystery", weight: 1 }] })).toThrow(RangeError);
  });
});

describe("a fight inside a run", () => {
  it("passes fight actions through and keeps the run in its fight phase", () => {
    const { state, events } = play(start(), { type: "deploy", slot: 0, kind: "exactMemory", spaceBits: 2048 }, { type: "endDeploy" });
    expect(state.phase).toBe("fight");
    expect(types(events)).toEqual(expect.arrayContaining(["structureDeployed", "burstIngested"]));
  });

  it("carries Certainty from one fight to the next", () => {
    const afterFirst = until(start(), "reward");
    const lost = 100 - afterFirst.certainty;
    expect(lost).toBeGreaterThan(0); // the enemy attacked on turn 1
    const next = play(afterFirst, { type: "chooseReward", index: 0 }).state;
    expect(next.fight?.certainty).toBe(afterFirst.certainty);
    expect(next.encounter).toBe(1);
  });

  it("derives each fight's seed from the run seed, so the same run replays and another differs", () => {
    const a = winFight(start("same")).state;
    const b = winFight(start("same")).state;
    expect(a).toEqual(b);
    expect(observeRun(start("other")).fight?.weakPoint).toBe(null);
    expect(start("same").fight?.stream).not.toEqual(start("other").fight?.stream);
  });

  it("gives every encounter its own stream", () => {
    const first = start("streams");
    const second = play(until(first, "reward"), { type: "chooseReward", index: 0 }).state;
    expect(second.fight?.stream.seed).not.toBe(first.fight?.stream.seed);
    expect(second.fight?.stream.seed).toMatch(/^streams\/fight\/1$/);
  });

  it("ends the run when the fight is lost", () => {
    const doomed = createRun("doom", runConfig({ encounters: [{ ...runConfig().encounters[0]!, attack: 500 }, ...runConfig().encounters.slice(1)] }));
    const { state, events } = play(doomed, { type: "endDeploy" });
    expect(state.phase).toBe("lost");
    expect(types(events)).toContain("runLost");
    expect(legalActions(state)).toEqual([]);
    expect(() => step(state, { type: "endDeploy" })).toThrow(IllegalActionError);
  });
});

describe("rewards", () => {
  it("offers the configured number of distinct rewards after a won fight, and does not repeat what is owned", () => {
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
  });

  it("is deterministic in the run seed, and different seeds see different offers", () => {
    const offers = (seed: string) => observeRun(until(start(seed), "reward")).offers?.map((o) => o.id).join();
    expect(offers("a")).toBe(offers("a"));
    expect(new Set(["a", "b", "c", "d", "e", "f"].map(offers)).size).toBeGreaterThan(1);
  });

  it("never offers a reward whose weight is zero, and offers fewer when fewer are eligible", () => {
    const only = runConfig({
      rewards: [
        { id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 },
        { id: "upgrade:slots", kind: "upgrade", upgrade: "slots", weight: 0 },
      ],
    });
    const view = observeRun(until(createRun("w", only), "reward"));
    expect(view.offers?.map((o) => o.id)).toEqual(["upgrade:power"]);
  });

  it("skips the reward phase when nothing is left to offer", () => {
    const nothing = runConfig({ rewards: [{ id: "structure:linearCounting", kind: "structure", structure: "linearCounting", weight: 1 }] });
    const run = winFight(createRun("none", nothing)).state; // already owned, so not eligible
    expect(run.phase).toBe("fight");
    expect(run.encounter).toBe(1);
  });

  it("refuses a reward action out of turn or out of range", () => {
    expect(() => step(start(), { type: "chooseReward", index: 0 })).toThrow(IllegalActionError);
    const run = until(start(), "reward");
    expect(() => step(run, { type: "chooseReward", index: 3 })).toThrow(IllegalActionError);
    expect(() => step(run, { type: "endDeploy" })).toThrow(IllegalActionError);
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

  it("Capacity adds Space and Slots adds a slot, in every later fight", () => {
    expect(observeRun(take("capacity").next).fight?.spaceFree).toBe(8192 + 1024);
    expect(observeRun(take("slots").next).fight?.slotsFree).toBe(4);
  });

  it("Resolve raises the maximum and the current Certainty", () => {
    const { reward, next } = take("resolve");
    expect(next.maxCertainty).toBe(120);
    expect(next.certainty).toBe(reward.certainty + 20);
  });

  it("Recovery restores Certainty after each fight, never above the maximum", () => {
    const { reward, next } = take("recovery");
    const after = until(next, "reward");
    const plain = until(createRun("up", runConfig({ rewards: [{ id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 }] })), "reward");
    expect(reward.certainty).toBeLessThanOrEqual(100);
    expect(after.certainty).toBeLessThanOrEqual(after.maxCertainty);
    // Two fights each cost Certainty; Recovery gives back 10 after the second (and the first fight's reward comes before it).
    const baseline = until(play(plain, { type: "chooseReward", index: 0 }).state, "reward");
    expect(after.certainty).toBe(Math.min(100, baseline.certainty + 10));
  });

  it("Power scales strike damage", () => {
    const { next } = take("power");
    const events = winFight(next).events;
    const strike = events.find((e) => e.type === "strikeResolved") as { damage: number } | undefined;
    expect(strike?.damage).toBeCloseTo(22, 6); // a perfect Frequency strike is BASE 20, plus 10 percent
  });

  it("stacks when the same upgrade is taken twice", () => {
    const config = runConfig({ rewards: [{ id: "upgrade:capacity", kind: "upgrade", upgrade: "capacity", weight: 1 }] });
    let run = createRun("stack", config);
    run = play(until(run, "reward"), { type: "chooseReward", index: 0 }).state;
    run = play(until(run, "reward"), { type: "chooseReward", index: 0 }, { type: "leaveRest" }).state; // a rest stop follows the second fight
    expect(run.upgrades).toEqual({ capacity: 2 });
    expect(run.fight?.config.rules.startingSpace).toBe(8192 + 2048);
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
  it("is won by winning the last encounter, with no reward after it, and counts the turns", () => {
    const final = until(start(), "won");
    expect(final.phase).toBe("won");
    expect(final.encounter).toBe(3);
    expect(turnsTaken(final)).toBe(8); // each test fight takes 2 turns
    expect(legalActions(final)).toEqual([]);
  });

  it("survives JSON unchanged, never changes the state it was given, and continues the same", () => {
    const run = until(start(), "reward");
    const frozen = JSON.stringify(run);
    const next = play(run, { type: "chooseReward", index: 1 }).state;
    expect(JSON.stringify(run)).toBe(frozen);
    const revived = JSON.parse(frozen) as RunState;
    expect(play(revived, { type: "chooseReward", index: 1 }).state).toEqual(next);
  });
});
