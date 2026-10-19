import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { createFight, legalActions, Rng, step, STRUCTURE_KINDS, type FightState } from "@pda/engine";
import { balance } from "./balance";
import { buildFightConfig } from "./fight";

describe("buildFightConfig", () => {
  it("takes the fight rules from balance.json; defaults to the starting loadout and accepts another; builds the same enemy for the same seed and tier; and 2 more", () => {
    // takes the fight rules from balance.json
    {
      const { rules, constants } = buildFightConfig({ seed: "rules", tier: "minion" });
      expect(rules).toEqual({
        startingSpace: balance.STARTING_SPACE,
        startingCertainty: balance.STARTING_CERTAINTY,
        startingSlots: balance.STARTING_SLOTS,
        base: balance.BASE,
        hitDamage: balance.HIT_DAMAGE,
        decoyPenalty: balance.DECOY_PENALTY,
        blockPenalty: balance.BLOCK_PENALTY,
        missPenalty: balance.MISS_PENALTY,
        overshootExp: balance.OVERSHOOT_EXP,
        countTol: balance.COUNT_TOL,
        rankTol: balance.RANK_TOL,
        presenceTargets: balance.PRESENCE_TARGETS,
        likeCopies: balance.LIKENESS_COPIES,
        likeThreshold: balance.LIKE_THRESHOLD,
        likeMinSet: balance.LIKE_MIN_SET,
        likeMaxSet: balance.LIKE_MAX_SET,
        likeRealMin: balance.LIKE_REAL_BAND.min,
        likeRealMax: balance.LIKE_REAL_BAND.max,
        cunningSearch: balance.CUNNING_SEARCH,
        expectedTurns: balance.EXPECTED_TURNS,
        turnLimitPenalty: balance.TURN_LIMIT_PENALTY,
        changesPerSlot: balance.DEPLOY_CHANGES_PER_SLOT,
      });
      expect(constants.valueBits).toBe(balance.VALUE_BITS);
    }
    // defaults to the starting loadout and accepts another
    {
      expect(buildFightConfig({ seed: "a", tier: "minion" }).loadout).toEqual(balance.STARTING_LOADOUT);
      expect(buildFightConfig({ seed: "a", tier: "minion", loadout: [...STRUCTURE_KINDS] }).loadout).toEqual([...STRUCTURE_KINDS]);
    }
    // builds the same enemy for the same seed and tier
    {
      expect(buildFightConfig({ seed: "x", tier: "elite" })).toEqual(buildFightConfig({ seed: "x", tier: "elite" }));
      expect(buildFightConfig({ seed: "x", tier: "elite" }).enemy).toEqual(buildFightConfig({ seed: "x", tier: "elite" }).enemy);
    }
    // starts a fight the engine accepts, with the spec's starting resources
    {
      const state = createFight("start", buildFightConfig({ seed: "start", tier: "minion" }));
      expect(state).toMatchObject({ turn: 1, phase: "deploy", certainty: balance.STARTING_CERTAINTY, enemyHp: balance.TIERS.minion.hp });
      expect(state.slots).toHaveLength(3);
    }
    // does not allow an unknown tier
    {
      expect(() => buildFightConfig({ seed: "bad", tier: "king" as never })).toThrow(RangeError);
    }
  });
});

describe("fights from generated enemies", () => {
  // A crude random player: finish deploying with some probability, otherwise take any listed action.
  function playRandomly(seed: string, tier: "minion" | "elite" | "boss") {
    const config = buildFightConfig({ seed, tier, loadout: [...STRUCTURE_KINDS] });
    let state: FightState = createFight(seed, config);
    const rng = Rng.fromSeed(`fuzz/${seed}`);
    let steps = 0;
    while (state.phase !== "won" && state.phase !== "lost" && steps < 400) {
      const actions = legalActions(state);
      expect(actions.length).toBeGreaterThan(0);
      const done = actions.find((a) => a.type === "endDeploy");
      const action = done && rng.float() < 0.4 ? done : actions[rng.int(actions.length)];
      const result = step(state, action as (typeof actions)[number]);
      expect(Number.isFinite(result.reward)).toBe(true);
      state = result.state;
      steps++;
    }
    return { state, steps, config };
  }

  it("never breaks the engine under random play, in any tier; every generated fight can be saved as JSON mid-way and resumed", () => {
    // never breaks the engine under random play, in any tier
    {
      eachCase((["minion", "elite", "boss"] as const).map((tier) => [tier, tier] as const), (tier) => {
        let finished = 0;
        for (let i = 0; i < 12; i++) {
          const { state, config } = playRandomly(`fuzz-${tier}-${i}`, tier);
          expect(state.certainty).toBeGreaterThanOrEqual(0);
          expect(state.certainty).toBeLessThanOrEqual(balance.STARTING_CERTAINTY);
          expect(state.enemyHp).toBeGreaterThanOrEqual(0);
          expect(state.enemyHp).toBeLessThanOrEqual(config.enemy.hp);
          if (state.phase === "won" || state.phase === "lost") finished++;
        }
        expect(finished).toBeGreaterThan(0);
      });
    }
    // every generated fight can be saved as JSON mid-way and resumed
    {
      const { state } = playRandomly("json-fuzz", "elite");
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });
});
