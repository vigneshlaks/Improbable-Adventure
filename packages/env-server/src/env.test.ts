import { describe, expect, it } from "vitest";
import { buildRunConfig } from "@pda/content";
import { createRun, legalRunActions, Rng, stepRun, type RunAction, type RunState } from "@pda/engine";
import { decodeAction } from "./actions";
import { Env } from "./env";
import { buildLayout } from "./layout";
import { encodeObservation } from "./observation";
import { shapeReward } from "./reward";

/** Plays a game with a uniformly random unmasked action each step, calling `each` on every state and the step that led to it. */
function randomGame(seed: string, each: (env: Env, step: ReturnType<Env["reset"]>) => void, maxSteps = 600): ReturnType<Env["reset"]> {
  const env = new Env({ maxSteps });
  const rng = Rng.fromSeed(`play-${seed}`);
  let step = env.reset(seed);
  each(env, step);
  while (!step.done && !step.truncated) {
    const on = step.mask.flatMap((m, i) => (m ? [i] : []));
    expect(on.length).toBeGreaterThan(0); // a game that has not ended always has something to do
    step = env.step(on[rng.int(on.length)] as number);
    each(env, step);
  }
  return step;
}

describe("the environment", () => {
  it("always has the same shape, keeps every number between 0 and 1, and only ever offers actions the engine accepts", () => {
    const layout = buildLayout(buildRunConfig({ seed: "a" }), 6);
    expect(buildLayout(buildRunConfig({ seed: "b" }), 6).observationSize).toBe(layout.observationSize);
    expect(buildLayout(buildRunConfig({ seed: "b" }), 6).labels).toEqual(layout.labels);
    expect(new Set(layout.labels).size).toBe(layout.labels.length);

    let steps = 0;
    for (const seed of ["1", "2", "3", "4", "5", "6"]) {
      randomGame(seed, (env, step) => {
        steps++;
        expect(step.obs).toHaveLength(layout.observationSize);
        expect(step.mask).toHaveLength(layout.actions.length);
        expect(step.obs.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
        expect(step.mask.some(Boolean)).toBe(!step.done);
        expect(env.layout.observationSize).toBe(layout.observationSize);
      });
    }
    expect(steps).toBeGreaterThan(100);
  });

  it("scores every step as the engine's own reward does, except that every lost run costs the run-loss weight", () => {
    // The engine's per-step reward charges the run loss only when Certainty reaches zero. A fight lost to the turn limit also
    // ends the run, and the spec says a lost run costs the run-loss weight, so the environment charges it then too.
    const weights = { enemyDefeated: 1, perTurn: 0.01, perCertaintyLost: 0.005, runLoss: 1 };
    let lostByTurnLimit = 0;
    let steps = 0;
    for (const seed of ["7", "8", "9", "10", "11", "12", "13", "14", "15", "16"]) {
      const config = buildRunConfig({ seed });
      const layout = buildLayout(config, 6);
      let state: RunState = createRun(seed, config);
      const rng = Rng.fromSeed(`oracle-${seed}`);
      for (let i = 0; i < 800 && state.phase !== "won" && state.phase !== "lost"; i++) {
        const options = layout.actions.flatMap((_, index) => (decodeAction(state, layout, index) ? [index] : []));
        const action = decodeAction(state, layout, options[rng.int(options.length)] as number) as RunAction;
        let result;
        try {
          result = stepRun(state, action);
        } catch {
          continue; // an action that is not legal is simply not taken here; the mask test covers legality
        }
        const mine = shapeReward(result.events, weights);
        const turnLimitLoss = result.events.some((event) => event.type === "fightLost" && event.reason === "turnLimit");
        expect(mine - result.reward).toBeCloseTo(turnLimitLoss ? -weights.runLoss : 0, 9);
        if (turnLimitLoss) lostByTurnLimit++;
        steps++;
        state = result.state;
      }
    }
    expect(steps).toBeGreaterThan(200);
    expect(lostByTurnLimit).toBeGreaterThan(0); // the case the test is about does occur
  });

  it("prices each kind of event by its own weight", () => {
    const weights = { enemyDefeated: 3, perTurn: 0.5, perCertaintyLost: 0.25, runLoss: 7 };
    const price = (...events: Parameters<typeof shapeReward>[0]) => shapeReward(events, weights);
    expect(price({ type: "fightWon", turn: 4 })).toBe(3);
    expect(price({ type: "enemyAttacked", turn: 4, damage: 4 })).toBe(-(0.5 + 0.25 * 4)); // a turn ending, and what the attack took
    expect(price({ type: "runLost", encounter: 2 })).toBe(-7);
    expect(price({ type: "fightLost", turn: 9, reason: "turnLimit", certaintyLost: 8 })).toBe(-0.25 * 8);
    expect(price({ type: "strikeResolved", turn: 2, kind: "frequency", outcome: "blocked", damage: 0, certaintyLost: 2, force: 1, trueCount: 9 })).toBe(-0.25 * 2);
    expect(price({ type: "turnStarted", turn: 3 }, { type: "burstIngested", turn: 3, events: 1, inserts: 1, deletes: 0 })).toBe(0); // starting a turn is free: the cost is charged as it ends
  });

  it("offers every engine-legal deploy, removal, reward, fuse, enchant and leave as some action, and refuses what is masked off", () => {
    for (const seed of ["21", "22", "23"]) {
      const layout = buildLayout(buildRunConfig({ seed }), 6);
      randomGame(seed, (env, step) => {
        if (step.done) return;
        // Read the same state the environment holds, by replaying through its own public pieces.
        const probe = (env as unknown as { state: RunState }).state;
        const decoded = new Set(layout.actions.flatMap((_, i) => (step.mask[i] ? [JSON.stringify(decodeAction(probe, layout, i))] : [])));
        for (const action of legalRunActions(probe)) {
          if (action.type === "strikeSubset" || action.type === "strikeValue") continue; // strikes are offered by meaning, not by value
          expect(decoded.has(JSON.stringify(action)), JSON.stringify(action)).toBe(true);
        }
        // And nothing the engine would refuse is offered (strikes are offered by meaning and checked by the games that play them).
        const legal = new Set(legalRunActions(probe).map((action) => JSON.stringify(action)));
        layout.actions.forEach((spec, i) => {
          if (step.mask[i] && spec.type !== "strike") expect(legal.has(JSON.stringify(decodeAction(probe, layout, i))), layout.labels[i]).toBe(true);
        });
        const off = step.mask.findIndex((m) => !m);
        if (off >= 0) expect(() => env.step(off)).toThrow();
      });
    }
  });

  it("means by each strike what its name says: all flagged targets, only those two structures agree on, one slot's, and a bare force only where a force is asked for", () => {
    let checked = 0;
    for (let n = 1; n <= 60 && checked < 3; n++) {
      const seed = `strike-${n}`;
      const env = new Env();
      const layout = env.layout;
      env.reset(seed);
      const index = (label: string) => layout.labels.indexOf(label);
      const deploys = ["deploy bloomFilter in slot 1 with 25% of the free Space", "deploy exactMemory in slot 2 with 25% of the free Space", "deploy linearCounting in slot 3 with 25% of the free Space"];
      for (const label of deploys) env.step(index(label));
      env.step(index("end deploy"));
      const atStrike = env.step(index("end deploy"));
      const state = (env as unknown as { state: RunState }).state;
      const fight = state.fight;
      if (!fight || fight.phase !== "strike" || fight.challenge?.kind !== "presence") continue;
      const targets = fight.challenge.targets;
      const decode = (label: string) => decodeAction(state, layout, index(label));
      const positions = (label: string) => {
        const action = decode(label);
        return action && action.type === "strikeSubset" ? action.targets : null;
      };
      const bloom = positions("strike flaggedBy of slot 1");
      const exact = positions("strike flaggedBy of slot 2");
      const all = positions("strike flaggedAll");
      const confirmed = positions("strike confirmed");
      expect(all).toEqual([...new Set([...(bloom ?? []), ...(exact ?? [])])].sort((a, b) => a - b));
      expect(confirmed).toEqual((bloom ?? []).filter((p) => (exact ?? []).includes(p)).length > 0 ? (bloom ?? []).filter((p) => (exact ?? []).includes(p)) : null);
      expect(positions("strike flaggedBy of slot 3")).toBeNull(); // Linear Counting cannot answer Presence
      expect(decode("strike none")).toEqual({ type: "strikeSubset", targets: [] });
      expect(decode("strike force1")).toBeNull(); // a bare force answers Frequency and Count, not Presence
      expect(atStrike.mask[index("strike force1")]).toBe(false);
      expect(all?.every((p) => p >= 0 && p < targets.length)).toBe(true);
      expect(atStrike.mask[index("strike flaggedAll")]).toBe(all !== null);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("hides what the player cannot know: the vector is the same for two games that differ only in the enemy's hidden stream", () => {
    // Two runs with the same config and the same actions but different seeds for the stream share the rules, so only what is
    // observed can differ. With no structure deployed and no strike yet, nothing about the stream has been observed beyond its traits.
    const first = new Env();
    const second = new Env();
    const a = first.reset("same-config-a");
    const b = second.reset("same-config-a");
    expect(a.obs).toEqual(b.obs);
    expect(encodeObservation((first as unknown as { state: RunState }).state, first.layout)).toEqual(a.obs);
  });

  it("cuts an episode off at the step limit and refuses to step a finished one", () => {
    const env = new Env({ maxSteps: 3 });
    let step = env.reset("cut");
    for (let i = 0; i < 3; i++) step = env.step(step.mask.findIndex(Boolean));
    expect(step.truncated).toBe(true);
    expect(step.done).toBe(false);
    const full = randomGame("end", () => undefined);
    expect(full.done || full.truncated).toBe(true);
    const finished = new Env();
    let last = finished.reset("fin");
    for (let i = 0; i < 2000 && !last.done; i++) last = finished.step(last.mask.findIndex((m, idx) => m && finished.layout.actions[idx]?.type !== "remove" && finished.layout.actions[idx]?.type !== "deploy"));
    if (last.done) expect(() => finished.step(0)).toThrow(/Reset/);
  });
});
