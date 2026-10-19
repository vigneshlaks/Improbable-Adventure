import { describe, expect, it } from "vitest";
import {
  createFight,
  groundTruth,
  legalActions,
  observe,
  step,
  type Action,
  type FightConfig,
  type FightState,
  type GameEvent,
} from "./index";
import { TEST_CONSTANTS } from "../structures/testUtils";

// A small, fast enemy: few distinct values and a steep skew, so one value clearly dominates after a
// single burst. With 1,000 events over 5 expected turns, each burst is about 200 events.
const CONFIG: FightConfig = {
  constants: TEST_CONSTANTS,
  rules: {
    startingSpace: 8192,
    startingCertainty: 100,
    startingSlots: 3,
    base: 20,
    hitDamage: 5,
    decoyPenalty: 4,
    blockPenalty: 3,
    missPenalty: 3,
    overshootExp: 2,
    countTol: 0.25,
    rankTol: 0.1,
    presenceTargets: 12,
    likeCopies: 6,
    likeThreshold: 0.6,
    likeMinSet: 12,
    likeMaxSet: 1000,
    likeRealMin: 0.66,
    likeRealMax: 0.95,
    cunningSearch: 2000,
    expectedTurns: 5,
    turnLimitPenalty: 20,
    changesPerSlot: 2,
  },
  loadout: ["exactMemory", "reservoirSampling", "bloomFilter", "countMinSketch"],
  enemy: {
    tier: "minion",
    size: 1000,
    hp: 20,
    attack: 3,
    turnLimit: 4,
    traits: { variety: "low", skew: "high", churn: "low", growth: "low", drift: "low", likeness: "low", cunning: "low" },
    weakPoints: ["frequency"],
  },
  traitTables: {
    variety: { low: 256, medium: 16384, high: 4194304 },
    skew: { low: 0, medium: 0.8, high: 1.2 },
    churn: { low: 0, medium: 0.1, high: 0.3 },
    growth: { low: 1, medium: 1.15, high: 1.35 },
    drift: {
      low: { fraction: 0, everyTurns: 0 },
      medium: { fraction: 0.25, everyTurns: 4 },
      high: { fraction: 0.5, everyTurns: 3 },
    },
    likeness: { low: { min: 0.05, max: 0.3 }, medium: { min: 0.35, max: 0.5 }, high: { min: 0.5, max: 0.58 } },
    cunning: { low: { events: 0, decoys: 0 }, medium: { events: 0.05, decoys: 0.5 }, high: { events: 0.15, decoys: 1 } },
  },
};

const deployCms: Action = { type: "deploy", slot: 0, kind: "countMinSketch", spaceBits: 4096 };
const endDeploy: Action = { type: "endDeploy" };

/** Apply actions in order, collecting every event. */
function run(state: FightState, actions: Action[]): { state: FightState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let current = state;
  for (const action of actions) {
    const result = step(current, action);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

const types = (events: GameEvent[]) => events.map((e) => e.type);

/** Strike at the Count-Min sketch's upper bound, which is safe because it never underestimates. */
function strikeAtCmsHigh(state: FightState): Action {
  const cms = observe(state).structures.find((s) => s.kind === "countMinSketch");
  if (!cms?.answer) throw new Error("expected a Count-Min answer");
  return { type: "strikeValue", value: Math.ceil(cms.answer.high) };
}

/** Play greedily until the fight ends or a safety limit is hit. */
function playGreedy(seed: string): { state: FightState; events: GameEvent[] } {
  let state = createFight(seed, CONFIG);
  const events: GameEvent[] = [];
  const apply = (action: Action) => {
    const result = step(state, action);
    state = result.state;
    events.push(...result.events);
    return result.done;
  };
  apply(deployCms);
  for (let i = 0; i < 20; i++) {
    if (apply(endDeploy)) break;
    if (observe(state).challenge && apply(strikeAtCmsHigh(state))) break;
  }
  return { state, events };
}

describe("enchantments in a fight", () => {
  const bloom = (slot: number): Action => ({ type: "deploy", slot, kind: "bloomFilter", spaceBits: 2048 });
  const enchanted: FightConfig = { ...CONFIG, loadout: ["bloomFilter", "exactMemory"], enchantments: { bloomFilter: "seeded" } };
  const hashSeedOf = (state: FightState, slot: number) => state.slots[slot]?.hashSeed;

  it("builds a Seeded structure with a hash seed of its own, and leaves other structures on the public seed; gives a different seed to each deployment, the same seed to the same deployment in the same fight, and another fight another seed; draws the seed from a stream of its own, so it never shifts the choices a sampling structure makes; and 2 more", () => {
    // builds a Seeded structure with a hash seed of its own, and leaves other structures on the public seed
    {
      let state = createFight("seeded", enchanted);
      state = step(state, bloom(0)).state;
      state = step(state, { type: "deploy", slot: 1, kind: "exactMemory", spaceBits: 1024 }).state;
      expect(hashSeedOf(state, 0)).toBeTypeOf("number");
      expect(state.slots[0]).toMatchObject({ kind: "bloomFilter", enchantment: "seeded" });
      expect(state.slots[1]?.enchantment).toBeUndefined();
      expect(hashSeedOf(state, 1)).toBeUndefined(); // Exact Memory is not enchanted and keeps the default
    }
    // gives a different seed to each deployment, the same seed to the same deployment in the same fight, and another fight another seed
    {
      const seeds = (fightSeed: string) => {
        let state = createFight(fightSeed, enchanted);
        state = step(state, bloom(0)).state;
        state = step(state, bloom(1)).state;
        return [hashSeedOf(state, 0), hashSeedOf(state, 1)];
      };
      const [a, b] = seeds("fight-a");
      expect(a).not.toBe(b);
      expect(seeds("fight-a")).toEqual([a, b]);
      expect(seeds("fight-b")).not.toEqual([a, b]);
    }
    // draws the seed from a stream of its own, so it never shifts the choices a sampling structure makes
    {
      const sampleAfter = (config: FightConfig) => {
        let state = createFight("stream", config);
        state = step(state, { type: "deploy", slot: 0, kind: "reservoirSampling", spaceBits: 32 * 20 }).state;
        state = step(state, endDeploy).state;
        return state.slots[0]?.state.sample;
      };
      const plain: FightConfig = { ...CONFIG, loadout: ["reservoirSampling"] };
      expect(sampleAfter({ ...plain, enchantments: { reservoirSampling: "seeded" } })).toEqual(sampleAfter(plain));
    }
    // does not touch an unenchanted structure, and the enchantment shows to the player
    {
      let state = createFight("plain", { ...CONFIG, loadout: ["bloomFilter"] });
      state = step(state, bloom(0)).state;
      expect(hashSeedOf(state, 0)).toBeUndefined();
      expect(observe(state).structures[0]?.enchantment).toBeUndefined();

      let fancy = createFight("fancy", enchanted);
      fancy = step(fancy, bloom(0)).state;
      expect(observe(fancy).structures[0]?.enchantment).toBe("seeded");
    }
    // survives a snapshot round trip: the structure comes back with its seed and its enchantment
    {
      let state = createFight("round", enchanted);
      state = step(state, bloom(0)).state;
      const revived = JSON.parse(JSON.stringify(state)) as FightState;
      expect(revived).toEqual(state);
      expect(observe(revived).structures[0]).toMatchObject({ kind: "bloomFilter", enchantment: "seeded" });
      // And it keeps working: the stream arrives and the structure ingests it.
      expect(() => step(revived, endDeploy)).not.toThrow();
    }
  });
});

describe("damageMultiplier", () => {
  it("scales the damage of every strike, and the event reports the scaled damage", () => {
    const strikeDamage = (multiplier?: number) => {
      const config: FightConfig = { ...CONFIG, rules: { ...CONFIG.rules, ...(multiplier ? { damageMultiplier: multiplier } : {}) } };
      let state = createFight("mult", config);
      state = step(state, endDeploy).state;
      state = step(state, endDeploy).state;
      const count = groundTruth(state).frequency?.count ?? 1;
      const result = step(state, { type: "strikeValue", value: count });
      return { damage: (result.events.find((e) => e.type === "strikeResolved") as { damage: number }).damage, hp: result.state.enemyHp };
    };
    expect(strikeDamage()).toMatchObject({ damage: 20, hp: 0 });
    expect(strikeDamage(1.5)).toMatchObject({ damage: 30, hp: 0 }); // 20 x 1.5, and the enemy's 20 HP are gone
    expect(strikeDamage(0.5)).toMatchObject({ damage: 10, hp: 10 });
  });
});

describe("starting a fight", () => {
  const obs = observe(createFight("start", CONFIG));

  it("opens in the deploy phase on turn 1 with full resources; shows trait levels but hides the weak point and has no challenge yet; exposes only the documented fields, so hidden truth cannot leak", () => {
    // opens in the deploy phase on turn 1 with full resources
    {
      expect(obs).toMatchObject({
        turn: 1,
        phase: "deploy",
        certainty: 100,
        spaceFree: 8192,
        slotsFree: 3,
        enemyHp: 20,
      });
    }
    // shows trait levels but hides the weak point and has no challenge yet
    {
      expect(obs.traits).toEqual(CONFIG.enemy.traits);
      expect(obs.weakPoint).toBeNull();
      expect(obs.challenge).toBeNull();
      expect(obs.structures).toEqual([]);
    }
    // exposes only the documented fields, so hidden truth cannot leak
    {
      expect(Object.keys(obs).sort()).toEqual(
        ["certainty", "challenge", "changesLeft", "enemyHp", "phase", "slotsFree", "spaceFree", "structures", "traits", "turn", "weakPoint"].sort(),
      );
    }
  });
});

describe("deploy rules", () => {
  const fresh = () => createFight("deploy", CONFIG);

  it("charges Space and uses a slot; refunds Space when a structure is removed; rejects illegal actions; and 1 more", () => {
    // charges Space and uses a slot
    {
      const { state } = run(fresh(), [deployCms]);
      expect(observe(state)).toMatchObject({ spaceFree: 8192 - 4096, slotsFree: 2 });
      expect(observe(state).structures).toMatchObject([{ slot: 0, kind: "countMinSketch", spaceBits: 4096 }]);
    }
    // refunds Space when a structure is removed
    {
      const { state } = run(fresh(), [deployCms, { type: "remove", slot: 0 }]);
      expect(observe(state)).toMatchObject({ spaceFree: 8192, slotsFree: 3, structures: [] });
    }
    // rejects illegal actions
    {
      expect(() => step(fresh(), { type: "deploy", slot: 0, kind: "countMinSketch", spaceBits: 9000 })).toThrow(); // over budget
      expect(() => step(fresh(), { type: "deploy", slot: 3, kind: "countMinSketch", spaceBits: 1024 })).toThrow(); // no such slot
      expect(() => step(fresh(), { type: "deploy", slot: 0, kind: "linearCounting", spaceBits: 1024 })).toThrow(); // not owned
      expect(() => step(fresh(), { type: "remove", slot: 1 })).toThrow(); // nothing there
      expect(() => step(fresh(), { type: "strikeValue", value: 5 })).toThrow(); // wrong phase
      const { state } = run(fresh(), [deployCms]);
      expect(() => step(state, deployCms)).toThrow(); // slot already taken
    }
    // only lists actions that step accepts
    {
      for (const state of [fresh(), run(fresh(), [deployCms, endDeploy, endDeploy]).state]) {
        const actions = legalActions(state);
        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) expect(() => step(state, action)).not.toThrow();
      }
    }
  });
});

describe("changes in a turn", () => {
  it("allows changesPerSlot deploys and removals per slot in a turn, then offers only endDeploy; counts removals as well as deploys, not refused actions; and gives the changes back when the next turn begins", () => {
    const cap = CONFIG.rules.changesPerSlot * CONFIG.rules.startingSlots; // 6
    const fresh = createFight("changes", CONFIG);
    expect(observe(fresh).changesLeft).toBe(cap);

    // Deploy and remove in slot 0, then fill slot 1, until the turn's changes are used up: both kinds count.
    let state = fresh;
    for (let i = 0; i < cap - 1; i++) {
      state = step(state, i % 2 === 0 ? { ...deployCms, spaceBits: 512 } : { type: "remove", slot: 0 }).state;
      expect(observe(state).changesLeft).toBe(cap - i - 1);
    }
    state = step(state, { ...deployCms, slot: 1, spaceBits: 512 }).state; // the last change; slots 0 and 1 are now both in use
    expect(observe(state).changesLeft).toBe(0);
    expect(() => step(state, { ...deployCms, slot: 2, spaceBits: 512 })).toThrow(/No more changes this turn/);
    expect(() => step(state, { type: "remove", slot: 0 })).toThrow(/No more changes this turn/);
    expect(legalActions(state)).toEqual([endDeploy]); // nothing but the way forward is offered
    expect(observe(state).changesLeft).toBe(0); // a refused action used nothing

    // The next turn starts with all of them back, and ending the deploy phase did not need one.
    const next = run(state, [endDeploy]).state; // turn 1 has no challenge, so ending the deploy phase ends the turn
    expect(next.turn).toBe(2);
    expect(observe(next).changesLeft).toBe(cap);
    expect(legalActions(next).some((a) => a.type === "deploy")).toBe(true);

    // More slots allow more changes, and the rule must be a whole number of at least one.
    expect(observe(createFight("changes", { ...CONFIG, rules: { ...CONFIG.rules, startingSlots: 5 } })).changesLeft).toBe(10);
    expect(() => createFight("changes", { ...CONFIG, rules: { ...CONFIG.rules, changesPerSlot: 0 } })).toThrow(RangeError);
  });
});

describe("the turn loop", () => {
  it("turn 1 ingests a burst, issues no challenge, and the enemy still attacks; from turn 2 the enemy issues a Frequency challenge that names the heaviest live value; answers the challenge from each deployed structure that can; and 1 more", () => {
    // turn 1 ingests a burst, issues no challenge, and the enemy still attacks
    {
      const afterDeploy = run(createFight("loop", CONFIG), [deployCms]);
      const turn1 = step(afterDeploy.state, endDeploy);
      expect(types(turn1.events)).toEqual(["burstIngested", "enemyAttacked", "turnStarted"]);
      expect(observe(turn1.state)).toMatchObject({ turn: 2, phase: "deploy", certainty: 97, challenge: null, weakPoint: null });
    }
    // from turn 2 the enemy issues a Frequency challenge that names the heaviest live value
    {
      const { state } = run(createFight("loop", CONFIG), [deployCms, endDeploy]);
      const turn2 = step(state, endDeploy);
      expect(types(turn2.events)).toEqual(["burstIngested", "challengeIssued"]);

      const obs = observe(turn2.state);
      expect(obs.phase).toBe("strike");
      expect(obs.weakPoint).toBe("frequency");
      expect(obs.challenge).toMatchObject({ kind: "frequency" });
      // The named value is the real heaviest value, but the player is never shown its true count.
      expect(obs.challenge).toEqual({ kind: "frequency", value: groundTruth(turn2.state).frequency?.value });
      expect(Object.keys(obs.challenge ?? {}).sort()).toEqual(["kind", "value"]);
      expect(legalActions(turn2.state).every((a) => a.type === "strikeValue")).toBe(true);
    }
    // answers the challenge from each deployed structure that can
    {
      const { state } = run(createFight("loop", CONFIG), [
        deployCms,
        { type: "deploy", slot: 1, kind: "bloomFilter", spaceBits: 2048 },
        endDeploy,
        endDeploy,
      ]);
      const [cms, bloom] = observe(state).structures;
      expect(cms?.answer).toMatchObject({ confidence: expect.any(Number) });
      expect(bloom?.answer).toBeNull(); // a Bloom filter cannot answer Frequency
    }
    // gives a structure deployed late no memory of earlier bursts
    {
      const { state } = run(createFight("late", CONFIG), [
        deployCms,
        endDeploy,
        { type: "deploy", slot: 1, kind: "countMinSketch", spaceBits: 4096 },
        endDeploy,
      ]);
      const [early, late] = observe(state).structures;
      expect(early?.answer?.estimate).toBeGreaterThan(late?.answer?.estimate as number);
    }
  });
});

describe("strikes", () => {
  const atChallenge = () => run(createFight("strike", CONFIG), [deployCms, endDeploy, endDeploy]).state;

  it("blocks a force below the true count and costs BLOCK_PENALTY; deals BASE x (f / s)^OVERSHOOT_EXP when the force reaches the true count; wastes force when overshooting", () => {
    // blocks a force below the true count and costs BLOCK_PENALTY
    {
      const before = atChallenge();
      const after = step(before, { type: "strikeValue", value: 1 });
      expect(after.events.find((e) => e.type === "strikeResolved")).toMatchObject({ outcome: "blocked", damage: 0 });
      // Block penalty 3 plus the enemy's attack of 3, on top of turn 1's attack of 3.
      expect(observe(after.state).certainty).toBe(97 - 3 - 3);
      expect(observe(after.state).enemyHp).toBe(20);
    }
    // deals BASE x (f / s)^OVERSHOOT_EXP when the force reaches the true count
    {
      const before = atChallenge();
      const f = groundTruth(before).frequency?.count as number;
      const action = strikeAtCmsHigh(before);
      const s = (action as { value: number }).value;
      expect(s).toBeGreaterThanOrEqual(f);

      const after = step(before, action);
      const resolved = after.events.find((e) => e.type === "strikeResolved");
      const expected = 20 * (f / s) ** 2;
      expect(resolved).toMatchObject({ outcome: "hit" });
      expect((resolved as { damage: number }).damage).toBeCloseTo(expected, 3);
      expect(observe(after.state).enemyHp).toBeCloseTo(Math.max(0, 20 - expected), 3);
    }
    // wastes force when overshooting
    {
      const before = atChallenge();
      const f = groundTruth(before).frequency?.count as number;
      const exact = step(before, { type: "strikeValue", value: f }).events.find((e) => e.type === "strikeResolved");
      const double = step(before, { type: "strikeValue", value: 2 * f }).events.find((e) => e.type === "strikeResolved");
      expect((exact as { damage: number }).damage).toBeCloseTo(20, 3);
      expect((double as { damage: number }).damage).toBeCloseTo(5, 3);
    }
  });
});

describe("ending a fight", () => {
  it("is won when the enemy's HP reaches zero within the turn limit; is lost at the turn limit with a Certainty penalty; rejects further actions once the fight is over", () => {
    // is won when the enemy's HP reaches zero within the turn limit
    {
      const { state, events } = playGreedy("win");
      expect(events.at(-1)?.type).toBe("fightWon");
      const obs = observe(state);
      expect(obs.enemyHp).toBe(0);
      expect(obs.turn).toBeLessThanOrEqual(CONFIG.enemy.turnLimit);
      expect(obs.certainty).toBeGreaterThan(0);
      expect(obs.certainty).toBeLessThanOrEqual(100);
    }
    // is lost at the turn limit with a Certainty penalty
    {
      let state = createFight("lose", CONFIG);
      let last: { events: GameEvent[]; done: boolean } = { events: [], done: false };
      const apply = (action: Action) => {
        const result = step(state, action);
        state = result.state;
        last = result;
      };
      apply(endDeploy); // turn 1
      for (let turn = 2; turn <= CONFIG.enemy.turnLimit; turn++) {
        apply(endDeploy);
        apply({ type: "strikeValue", value: 1 }); // always blocked
      }
      expect(last.done).toBe(true);
      expect(types(last.events)).toEqual(["strikeResolved", "enemyAttacked", "fightLost"]);
      expect(last.events.at(-1)).toMatchObject({ type: "fightLost", reason: "turnLimit" });
      // Four attacks (12), three blocked strikes (9) and the turn-limit penalty (20).
      expect(observe(state).certainty).toBe(100 - 12 - 9 - 20);
    }
    // rejects further actions once the fight is over
    {
      const { state } = playGreedy("over");
      expect(() => step(state, endDeploy)).toThrow();
      expect(legalActions(state)).toEqual([]);
    }
  });
});

describe("a Rank fight", () => {
  const rankConfig = (rankQuantile?: number): FightConfig => ({
    ...CONFIG,
    enemy: { ...CONFIG.enemy, weakPoints: ["rank"], ...(rankQuantile === undefined ? {} : { rankQuantile }) },
  });

  it("needs an enemy with the Rank weak point to name its quantile; issues the armor from turn 2, naming a rank; wins to a strike of the value that reaches it, and blocks a value below it", () => {
    expect(() => createFight("rank", rankConfig())).toThrow(RangeError); // no quantile
    expect(() => createFight("rank", rankConfig(1.5))).toThrow(RangeError);

    const atChallenge = () => run(createFight("rank-fight", rankConfig(0.9)), [endDeploy, endDeploy]).state;
    const state = atChallenge();
    expect(state.phase).toBe("strike");
    expect(state.challenge).toMatchObject({ kind: "rank" });
    const challenge = state.challenge as { kind: "rank"; quantile: number };
    expect(challenge.quantile).toBeGreaterThanOrEqual(0.9);
    expect(observe(state).challenge).toEqual(state.challenge); // the player is told the armor
    expect(observe(state)).not.toHaveProperty("rankValue"); // and not the value that reaches it

    const truth = groundTruth(state).answer;
    if (truth?.kind !== "rank") throw new Error("expected a rank answer");
    expect(truth.quantile).toBe(challenge.quantile);

    // The value that reaches the armor is a perfect hit: BASE damage kills the 20 HP enemy.
    const won = step(state, { type: "strikeValue", value: truth.value });
    expect(won.events.find((e) => e.type === "strikeResolved")).toMatchObject({ kind: "rank", outcome: "hit", damage: 20, certaintyLost: 0 });
    expect(won.state.phase).toBe("won");

    // A value below it is blocked: no damage, and the block penalty.
    const blocked = step(atChallenge(), { type: "strikeValue", value: 0 });
    expect(blocked.events.find((e) => e.type === "strikeResolved")).toMatchObject({ kind: "rank", outcome: "blocked", damage: 0, certaintyLost: 3 });
    expect(blocked.state.phase).toBe("deploy"); // the fight goes on to the next turn

    // A strike of the wrong kind is refused, as for the other numeric challenges.
    expect(() => step(atChallenge(), { type: "strikeSubset", targets: [0] })).toThrow(/answered with a value/);
  });
});

describe("groundTruth", () => {
  it("gives the real answer to the open challenge, and nothing when there is none; says which Presence targets are real", () => {
    // gives the real answer to the open challenge, and nothing when there is none
    {
      const deploying = createFight("truth", CONFIG);
      expect(groundTruth(deploying).answer).toBeNull();

      const striking = run(deploying, [deployCms, endDeploy, endDeploy]).state;
      const truth = groundTruth(striking);
      expect(truth.answer).toEqual({ kind: "frequency", count: truth.frequency?.count });
    }
    // says which Presence targets are real
    {
      const presence: FightConfig = { ...CONFIG, enemy: { ...CONFIG.enemy, weakPoints: ["presence"] } };
      const state = run(createFight("truth-presence", presence), [endDeploy, endDeploy]).state;
      const answer = groundTruth(state).answer;
      expect(answer?.kind).toBe("presence");
      const real = answer?.kind === "presence" ? answer.real : [];
      expect(real).toHaveLength(CONFIG.rules.presenceTargets);
      expect(real.filter(Boolean).length).toBeGreaterThanOrEqual(5);
      expect(real.filter(Boolean).length).toBeLessThanOrEqual(7);
    }
  });
});

describe("determinism and purity", () => {
  it("replays identically from the same seed; plays differently from different seeds; never mutates the state it is given; and 2 more", () => {
    // replays identically from the same seed
    {
      const a = playGreedy("replay");
      const b = playGreedy("replay");
      expect(a.events).toEqual(b.events);
      expect(a.state).toEqual(b.state);
    }
    // plays differently from different seeds
    {
      const named = ["s1", "s2", "s3", "s4", "s5"].map((seed) => {
        const { state } = run(createFight(seed, CONFIG), [deployCms, endDeploy, endDeploy]);
        return groundTruth(state).frequency?.value;
      });
      expect(new Set(named).size).toBeGreaterThan(1);
    }
    // never mutates the state it is given
    {
      let state = createFight("pure", CONFIG);
      // Each action is built when it is reached, because a strike can only be chosen once a challenge exists.
      const script: Array<(s: FightState) => Action> = [() => deployCms, () => endDeploy, () => endDeploy, strikeAtCmsHigh];
      for (const makeAction of script) {
        const action = makeAction(state);
        const before = JSON.stringify(state);
        const result = step(state, action);
        expect(JSON.stringify(state)).toBe(before); // the input is untouched
        expect(JSON.stringify(result.state)).not.toBe(before); // and the step really changed something
        state = result.state;
      }
    }
    // round-trips through JSON and continues identically
    {
      const prefix = run(createFight("json", CONFIG), [deployCms, endDeploy, endDeploy]).state;
      const restored: FightState = JSON.parse(JSON.stringify(prefix));
      expect(restored).toEqual(prefix);

      const rest = (start: FightState) => {
        const first = step(start, strikeAtCmsHigh(start));
        if (first.done) return { events: first.events, state: first.state }; // the strike already won the fight
        const second = step(first.state, endDeploy);
        return { events: [...first.events, ...second.events], state: second.state };
      };
      const direct = rest(prefix);
      const viaJson = rest(restored);
      expect(viaJson.events).toEqual(direct.events);
      expect(viaJson.state).toEqual(direct.state);
    }
    // reports a numeric reward on every step
    {
      const result = step(createFight("reward", CONFIG), endDeploy);
      expect(typeof result.reward).toBe("number");
    }
  });
});

describe("a Cunning enemy in a fight", () => {
  const cunning = (level: "low" | "high", weakPoint: "presence" | "count", extra: Partial<FightConfig> = {}): FightConfig => ({
    ...CONFIG,
    loadout: ["logLog", "bloomFilter", "exactMemory"],
    enemy: { ...CONFIG.enemy, size: 1020, turnLimit: 12, traits: { ...CONFIG.enemy.traits, skew: "low", cunning: level }, weakPoints: [weakPoint] },
    ...extra,
  });
  const deployLogLog: Action = { type: "deploy", slot: 0, kind: "logLog", spaceBits: 1024 };
  const deployBloom: Action = { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 2048 };
  const burstEvents = (events: GameEvent[]) => events.filter((e) => e.type === "burstIngested").map((e) => (e as { events: number }).events);
  const countEstimate = (state: FightState) => observe(state).structures[0]?.answer?.estimate as number;

  it("adds crafted events to the burst (CUNNING share of it) that inflate an open LogLog many times over and do little to a Seeded one, advances its search each turn, keeps the fight reproducible and JSON-safe, and does nothing when it is not Cunning", () => {
    const play = (config: FightConfig) => run(createFight("cunning-fight", config), [deployLogLog, endDeploy, endDeploy]);
    const calm = play(cunning("low", "count"));
    const open = play(cunning("high", "count"));
    const secret = play(cunning("high", "count", { enchantments: { logLog: "seeded" } }));

    // no extra events, no search, when it is not Cunning
    expect(calm.state.cunningCursor).toBe(0);
    // 15 percent more events in each burst (the burst itself is the same), and the search moves on by two stretches a turn
    const base = burstEvents(calm.events);
    expect(base).toHaveLength(2);
    expect(burstEvents(open.events)).toEqual(base.map((n) => n + Math.round(0.15 * n)));
    expect(burstEvents(secret.events)).toEqual(burstEvents(open.events)); // the enemy adds as many events whether or not they work
    expect(open.state.cunningCursor).toBe(2 * 2 * 2000);

    // the crafted events are in the truth, and are new values
    const truth = (r: { state: FightState }) => groundTruth(r.state).distinct;
    expect(truth(open) - truth(calm)).toBeGreaterThan(0);
    expect(truth(open) - truth(calm)).toBeLessThanOrEqual(Math.round(0.15 * base[0]!) + Math.round(0.15 * base[1]!));

    // an open LogLog is inflated far past the truth; a Seeded one is read as it would be without the attack
    expect(countEstimate(open.state)).toBeGreaterThan(5 * truth(open));
    expect(countEstimate(secret.state)).toBeLessThan(1.8 * truth(secret));
    expect(countEstimate(calm.state)).toBeLessThan(1.8 * truth(calm));

    // reproducible and JSON-safe
    expect(play(cunning("high", "count")).state).toEqual(open.state);
    expect(JSON.parse(JSON.stringify(open.state))).toEqual(open.state);
  });

  it("aims at the heaviest value of a Count-Min Sketch, whose estimate rises far above the truth when open and not when Seeded", () => {
    const deployCms0: Action = { type: "deploy", slot: 0, kind: "countMinSketch", spaceBits: 4096 };
    const play = (config: FightConfig) => run(createFight("cunning-cms", { ...config, loadout: ["countMinSketch", "exactMemory"], enemy: { ...config.enemy, size: 1020, turnLimit: 12, weakPoints: ["frequency"], traits: { ...config.enemy.traits, skew: "high", cunning: config.enemy.traits.cunning } } }), [deployCms0, endDeploy, endDeploy]).state;
    const overshoot = (state: FightState) => {
      const challenge = observe(state).challenge;
      if (challenge?.kind !== "frequency") throw new Error("expected a frequency challenge");
      return (observe(state).structures[0]?.answer?.estimate as number) - (groundTruth(state).frequency?.count ?? 0);
    };
    const open = overshoot(play(cunning("high", "count")));
    const secret = overshoot(play(cunning("high", "count", { enchantments: { countMinSketch: "seeded" } })));
    const calm = overshoot(play(cunning("low", "count")));
    expect(open).toBeGreaterThan(2 * Math.max(secret, calm, 1));
    expect(open).toBeGreaterThan(10);
  });

  it("offers Presence decoys that an open Bloom Filter flags and a Seeded one does not", () => {
    const decoysFlagged = (config: FightConfig) => {
      let state = createFight("cunning-presence", config);
      state = run(state, [deployBloom, endDeploy, endDeploy]).state; // turn 2: the Presence challenge
      const view = observe(state);
      if (view.challenge?.kind !== "presence") throw new Error("expected a presence challenge");
      const real = groundTruth(state).answer;
      if (real?.kind !== "presence") throw new Error("expected a presence answer");
      const flagged = new Set(view.structures[0]?.answer?.estimate as number[]);
      const decoys = view.challenge.targets.filter((_, i) => !real.real[i]);
      return { decoys: decoys.length, flagged: decoys.filter((t) => flagged.has(t)).length };
    };
    const open = decoysFlagged(cunning("high", "presence"));
    const secret = decoysFlagged(cunning("high", "presence", { enchantments: { bloomFilter: "seeded" } }));
    const calm = decoysFlagged(cunning("low", "presence"));
    expect(open.flagged).toBe(open.decoys); // decoyShare 1: every decoy is a false positive of the filter
    expect(open.decoys).toBeGreaterThan(3);
    expect(secret.flagged).toBeLessThan(open.flagged / 2);
    expect(calm.flagged).toBeLessThan(open.flagged / 2);
  });
});
