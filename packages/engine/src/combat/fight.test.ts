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

// A small, fast enemy: few distinct values and a steep skew, so one value clearly dominates after a
// single burst. With 1,000 events over 5 expected turns, each burst is about 200 events.
const CONFIG: FightConfig = {
  constants: { valueBits: 32, confidence: 0.95, cmsDefaultDepth: 4, logLogErrorCoefficient: 1.3 },
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
    presenceTargets: 12,
    expectedTurns: 5,
    turnLimitPenalty: 20,
  },
  loadout: ["exactMemory", "reservoirSampling", "bloomFilter", "countMinSketch"],
  enemy: {
    tier: "minion",
    size: 1000,
    hp: 20,
    attack: 3,
    turnLimit: 4,
    traits: { variety: "low", skew: "high", churn: "low", growth: "low", drift: "low" },
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

describe("starting a fight", () => {
  const obs = observe(createFight("start", CONFIG));

  it("opens in the deploy phase on turn 1 with full resources", () => {
    expect(obs).toMatchObject({
      turn: 1,
      phase: "deploy",
      certainty: 100,
      spaceFree: 8192,
      slotsFree: 3,
      enemyHp: 20,
    });
  });

  it("shows trait levels but hides the weak point and has no challenge yet", () => {
    expect(obs.traits).toEqual(CONFIG.enemy.traits);
    expect(obs.weakPoint).toBeNull();
    expect(obs.challenge).toBeNull();
    expect(obs.structures).toEqual([]);
  });

  it("exposes only the documented fields, so hidden truth cannot leak", () => {
    expect(Object.keys(obs).sort()).toEqual(
      ["certainty", "challenge", "enemyHp", "phase", "slotsFree", "spaceFree", "structures", "traits", "turn", "weakPoint"].sort(),
    );
  });
});

describe("deploy rules", () => {
  const fresh = () => createFight("deploy", CONFIG);

  it("charges Space and uses a slot", () => {
    const { state } = run(fresh(), [deployCms]);
    expect(observe(state)).toMatchObject({ spaceFree: 8192 - 4096, slotsFree: 2 });
    expect(observe(state).structures).toMatchObject([{ slot: 0, kind: "countMinSketch", spaceBits: 4096 }]);
  });

  it("refunds Space when a structure is removed", () => {
    const { state } = run(fresh(), [deployCms, { type: "remove", slot: 0 }]);
    expect(observe(state)).toMatchObject({ spaceFree: 8192, slotsFree: 3, structures: [] });
  });

  it("rejects illegal actions", () => {
    expect(() => step(fresh(), { type: "deploy", slot: 0, kind: "countMinSketch", spaceBits: 9000 })).toThrow(); // over budget
    expect(() => step(fresh(), { type: "deploy", slot: 3, kind: "countMinSketch", spaceBits: 1024 })).toThrow(); // no such slot
    expect(() => step(fresh(), { type: "deploy", slot: 0, kind: "linearCounting", spaceBits: 1024 })).toThrow(); // not owned
    expect(() => step(fresh(), { type: "remove", slot: 1 })).toThrow(); // nothing there
    expect(() => step(fresh(), { type: "strikeValue", value: 5 })).toThrow(); // wrong phase
    const { state } = run(fresh(), [deployCms]);
    expect(() => step(state, deployCms)).toThrow(); // slot already taken
  });

  it("only lists actions that step accepts", () => {
    for (const state of [fresh(), run(fresh(), [deployCms, endDeploy, endDeploy]).state]) {
      const actions = legalActions(state);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(() => step(state, action)).not.toThrow();
    }
  });
});

describe("the turn loop", () => {
  it("turn 1 ingests a burst, issues no challenge, and the enemy still attacks", () => {
    const afterDeploy = run(createFight("loop", CONFIG), [deployCms]);
    const turn1 = step(afterDeploy.state, endDeploy);
    expect(types(turn1.events)).toEqual(["burstIngested", "enemyAttacked", "turnStarted"]);
    expect(observe(turn1.state)).toMatchObject({ turn: 2, phase: "deploy", certainty: 97, challenge: null, weakPoint: null });
  });

  it("from turn 2 the enemy issues a Frequency challenge that names the heaviest live value", () => {
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
  });

  it("answers the challenge from each deployed structure that can", () => {
    const { state } = run(createFight("loop", CONFIG), [
      deployCms,
      { type: "deploy", slot: 1, kind: "bloomFilter", spaceBits: 2048 },
      endDeploy,
      endDeploy,
    ]);
    const [cms, bloom] = observe(state).structures;
    expect(cms?.answer).toMatchObject({ confidence: expect.any(Number) });
    expect(bloom?.answer).toBeNull(); // a Bloom filter cannot answer Frequency
  });

  it("gives a structure deployed late no memory of earlier bursts", () => {
    const { state } = run(createFight("late", CONFIG), [
      deployCms,
      endDeploy,
      { type: "deploy", slot: 1, kind: "countMinSketch", spaceBits: 4096 },
      endDeploy,
    ]);
    const [early, late] = observe(state).structures;
    expect(early?.answer?.estimate).toBeGreaterThan(late?.answer?.estimate as number);
  });
});

describe("strikes", () => {
  const atChallenge = () => run(createFight("strike", CONFIG), [deployCms, endDeploy, endDeploy]).state;

  it("blocks a force below the true count and costs BLOCK_PENALTY", () => {
    const before = atChallenge();
    const after = step(before, { type: "strikeValue", value: 1 });
    expect(after.events.find((e) => e.type === "strikeResolved")).toMatchObject({ outcome: "blocked", damage: 0 });
    // Block penalty 3 plus the enemy's attack of 3, on top of turn 1's attack of 3.
    expect(observe(after.state).certainty).toBe(97 - 3 - 3);
    expect(observe(after.state).enemyHp).toBe(20);
  });

  it("deals BASE x (f / s)^OVERSHOOT_EXP when the force reaches the true count", () => {
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
  });

  it("wastes force when overshooting", () => {
    const before = atChallenge();
    const f = groundTruth(before).frequency?.count as number;
    const exact = step(before, { type: "strikeValue", value: f }).events.find((e) => e.type === "strikeResolved");
    const double = step(before, { type: "strikeValue", value: 2 * f }).events.find((e) => e.type === "strikeResolved");
    expect((exact as { damage: number }).damage).toBeCloseTo(20, 3);
    expect((double as { damage: number }).damage).toBeCloseTo(5, 3);
  });
});

describe("ending a fight", () => {
  it("is won when the enemy's HP reaches zero within the turn limit", () => {
    const { state, events } = playGreedy("win");
    expect(events.at(-1)?.type).toBe("fightWon");
    const obs = observe(state);
    expect(obs.enemyHp).toBe(0);
    expect(obs.turn).toBeLessThanOrEqual(CONFIG.enemy.turnLimit);
    expect(obs.certainty).toBeGreaterThan(0);
    expect(obs.certainty).toBeLessThanOrEqual(100);
  });

  it("is lost at the turn limit with a Certainty penalty", () => {
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
  });

  it("rejects further actions once the fight is over", () => {
    const { state } = playGreedy("over");
    expect(() => step(state, endDeploy)).toThrow();
    expect(legalActions(state)).toEqual([]);
  });
});

describe("groundTruth", () => {
  it("gives the real answer to the open challenge, and nothing when there is none", () => {
    const deploying = createFight("truth", CONFIG);
    expect(groundTruth(deploying).answer).toBeNull();

    const striking = run(deploying, [deployCms, endDeploy, endDeploy]).state;
    const truth = groundTruth(striking);
    expect(truth.answer).toEqual({ kind: "frequency", count: truth.frequency?.count });
  });

  it("says which Presence targets are real", () => {
    const presence: FightConfig = { ...CONFIG, enemy: { ...CONFIG.enemy, weakPoints: ["presence"] } };
    const state = run(createFight("truth-presence", presence), [endDeploy, endDeploy]).state;
    const answer = groundTruth(state).answer;
    expect(answer?.kind).toBe("presence");
    const real = answer?.kind === "presence" ? answer.real : [];
    expect(real).toHaveLength(CONFIG.rules.presenceTargets);
    expect(real.filter(Boolean).length).toBeGreaterThanOrEqual(5);
    expect(real.filter(Boolean).length).toBeLessThanOrEqual(7);
  });
});

describe("determinism and purity", () => {
  it("replays identically from the same seed", () => {
    const a = playGreedy("replay");
    const b = playGreedy("replay");
    expect(a.events).toEqual(b.events);
    expect(a.state).toEqual(b.state);
  });

  it("plays differently from different seeds", () => {
    const named = ["s1", "s2", "s3", "s4", "s5"].map((seed) => {
      const { state } = run(createFight(seed, CONFIG), [deployCms, endDeploy, endDeploy]);
      return groundTruth(state).frequency?.value;
    });
    expect(new Set(named).size).toBeGreaterThan(1);
  });

  it("never mutates the state it is given", () => {
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
  });

  it("round-trips through JSON and continues identically", () => {
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
  });

  it("reports a numeric reward on every step", () => {
    const result = step(createFight("reward", CONFIG), endDeploy);
    expect(typeof result.reward).toBe("number");
  });
});
