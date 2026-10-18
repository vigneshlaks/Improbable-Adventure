import { describe, expect, it } from "vitest";
import { IllegalActionError } from "../combat/types";
import { Rng } from "../rng/rng";
import { STRUCTURE_KINDS, type StructureKind } from "../structures/types";
import { createRun, legalActions, step } from "./run";
import { play, runConfig, weakEnemy, winFight } from "./testUtils";
import type { RunAction, RunState } from "./types";

/** An action that spends no turn and changes nothing about the fight's clock: the ones a stalling player would repeat. */
const spendsNoTurn = (action: RunAction) => action.type === "deploy" || action.type === "remove" || action.type === "enchant";

/** Every kind of action, with junk values as well, so a player (or a learner) that tries anything is covered. */
function anything(rng: Rng, slots: number): RunAction {
  const kind = STRUCTURE_KINDS[rng.int(STRUCTURE_KINDS.length)] as StructureKind;
  switch (rng.int(8)) {
    case 0:
      return { type: "deploy", slot: rng.int(slots + 1), kind, spaceBits: 1 + rng.int(9000) };
    case 1:
      return { type: "remove", slot: rng.int(slots + 1) };
    case 2:
      return { type: "endDeploy" };
    case 3:
      return { type: "strikeValue", value: rng.int(50) };
    case 4:
      return { type: "strikeSubset", targets: [rng.int(12)] };
    case 5:
      return { type: "chooseReward", index: rng.int(4) };
    case 6:
      return { type: "enchant", enchantmentId: rng.next() % 2 === 0 ? "seeded" : "other", kind };
    default:
      return { type: "leaveRest" };
  }
}

/** Tries an action. A refused one changes nothing, so it is not progress and not counted. */
function attempt(state: RunState, action: RunAction): { state: RunState; accepted: boolean } {
  try {
    return { state: step(state, action).state, accepted: true };
  } catch (error) {
    if (error instanceof IllegalActionError) return { state, accepted: false };
    throw error;
  }
}

const finished = (state: RunState) => state.phase === "won" || state.phase === "lost";

describe("no fight or rest stop can go on forever", () => {
  /** A player who always takes an action that spends no turn when one is offered, and only then the cheapest way forward. */
  const stall = (state: RunState, rng: Rng): RunAction => {
    const legal = legalActions(state);
    const free = legal.filter(spendsNoTurn);
    if (free.length > 0) return free[rng.int(free.length)] as RunAction;
    return legal.find((a) => a.type === "endDeploy") ?? legal.find((a) => a.type === "leaveRest") ?? (legal[rng.int(legal.length)] as RunAction);
  };

  it("ends every fight within its turn limit however a stalling player acts", () => {
    let longest = 0;
    for (const slots of [1, 2, 3, 5]) {
      for (const turnLimit of [2, 4, 6]) {
        const config = runConfig({
          rules: { ...runConfig().rules, startingSlots: slots },
          encounters: [weakEnemy("minion", { turnLimit, hp: 1e9 })], // one that cannot be beaten, so only the turn limit can end it
          restBefore: [],
        });
        const changesCap = config.rules.changesPerSlot * slots;
        const rng = Rng.fromSeed(`stall-${slots}-${turnLimit}`);
        let state: RunState = createRun(`stall-${slots}-${turnLimit}`, config);
        let taken = 0;
        let tries = 0;
        while (!finished(state) && taken < 5000 && tries++ < 20000) {
          const move = attempt(state, stall(state, rng));
          if (!move.accepted) continue; // an action that is offered but refused would spin here, so tries is bounded too
          state = move.state;
          taken++;
          // At most the allowed changes in each turn, then one action to end the deploy phase and one strike.
          expect(taken, `slots ${slots}, turn limit ${turnLimit}`).toBeLessThanOrEqual(turnLimit * (changesCap + 2));
          if (state.fight) expect(state.fight.turn).toBeLessThanOrEqual(turnLimit);
        }
        expect(state.phase, `slots ${slots}, turn limit ${turnLimit}: the fight ended`).toBe("lost");
        longest = Math.max(longest, taken);
      }
    }
    expect(longest).toBeGreaterThan(10); // the stalling player really did take many free actions before the limit stopped it
  });

  it("lets a rest stop be left however a stalling player shuffles enchantments", () => {
    const config = runConfig({ restBefore: [1] });
    const rng = Rng.fromSeed("stall-rest");
    let state: RunState = createRun("stall-rest", config);
    state = winFight(state).state; // the first fight is won, so a reward and then the rest stop follow
    state = play(state, { type: "chooseReward", index: 0 }).state;
    expect(state.phase).toBe("rest");
    state = { ...state, enchantments: ["seeded", "other"] }; // two spare enchantments, with structures they can be moved between
    let taken = 0;
    let tries = 0;
    while (state.phase === "rest" && taken < 500 && tries++ < 2000) {
      const move = attempt(state, stall(state, rng));
      if (move.accepted) {
        state = move.state;
        taken++;
      }
    }
    expect(state.phase).toBe("fight"); // it left the rest stop
    expect(taken).toBeLessThanOrEqual(config.restEnchantLimit + 1);
    expect(taken).toBeGreaterThan(config.restEnchantLimit - 1); // and it did shuffle up to the limit first
  });

  it("keeps every invariant for arbitrary action sequences, including ones that are mostly refused", () => {
    let accepted = 0;
    let refused = 0;
    for (let n = 0; n < 150; n++) {
      const config = runConfig({ encounters: [weakEnemy("minion", { turnLimit: 3, hp: 1e9 }), weakEnemy("elite", { turnLimit: 3, hp: 1e9 })], restBefore: [1] });
      const rng = Rng.fromSeed(`arbitrary-${n}`);
      let state: RunState = { ...createRun(`arbitrary-${n}`, config), enchantments: ["seeded", "other"] };
      for (let i = 0; i < 3000 && !finished(state); i++) { // attempts, not accepted actions, so this always stops
        const move = attempt(state, anything(rng, 3));
        if (move.accepted) accepted++;
        else refused++;
        state = move.state;
        if (state.fight) {
          expect(state.fight.turn).toBeLessThanOrEqual(3); // never past the turn limit
          expect(state.fight.changes).toBeLessThanOrEqual(config.rules.changesPerSlot * state.fight.slots.length);
        }
        expect(state.restEnchants).toBeLessThanOrEqual(config.restEnchantLimit);
      }
      expect(finished(state), `sequence ${n} ended`).toBe(true);
    }
    expect(accepted).toBeGreaterThan(400);
    expect(refused).toBeGreaterThan(500); // plenty of junk was tried, and none of it counted
  });
});
