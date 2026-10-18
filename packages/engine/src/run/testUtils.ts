import { TEST_CONSTANTS } from "../structures/testUtils";
import { groundTruth } from "../combat/view";
import type { EnemyConfig } from "../combat/types";
import { step } from "./run";
import type { RewardDef, RunAction, RunConfig, RunEvent, RunState, RunStepResult } from "./types";
import type { GameEvent } from "../combat/types";

/** An enemy that dies to one exact Frequency strike and attacks lightly. */
export const weakEnemy = (tier: EnemyConfig["tier"] = "minion", overrides: Partial<EnemyConfig> = {}): EnemyConfig => ({
  tier,
  size: 1000,
  hp: 20,
  attack: 3,
  turnLimit: 6,
  traits: { variety: "low", skew: "high", churn: "low", growth: "low", drift: "low" },
  weakPoints: ["frequency"],
  ...overrides,
});

export const REWARDS: RewardDef[] = [
  { id: "structure:countMinSketch", kind: "structure", structure: "countMinSketch", weight: 3 },
  { id: "structure:logLog", kind: "structure", structure: "logLog", weight: 3 },
  { id: "upgrade:capacity", kind: "upgrade", upgrade: "capacity", weight: 2 },
  { id: "upgrade:slots", kind: "upgrade", upgrade: "slots", weight: 2 },
  { id: "upgrade:resolve", kind: "upgrade", upgrade: "resolve", weight: 2 },
  { id: "upgrade:recovery", kind: "upgrade", upgrade: "recovery", weight: 2 },
  { id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 2 },
];

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
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
      overshootExp: 1,
      countTol: 0.25,
      presenceTargets: 12,
      expectedTurns: 5,
      turnLimitPenalty: 20,
      changesPerSlot: 2,
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
    loadout: ["exactMemory", "reservoirSampling", "bloomFilter", "linearCounting"],
    encounters: [weakEnemy(), weakEnemy(), weakEnemy("elite"), weakEnemy("boss")],
    restBefore: [2],
    restHeal: 30,
    rewardChoices: 3,
    restEnchantLimit: 6,
    rewards: REWARDS,
    fusions: [{ id: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" }],
    enchantments: [
      { id: "seeded", valid: ["bloomFilter", "countMinSketch", "logLog", "linearCounting", "hyperLogLog"] },
      { id: "other", valid: ["bloomFilter", "exactMemory"] },
    ],
    upgrades: {
      capacity: { space: 1024 },
      slots: { slots: 1 },
      resolve: { maxCertainty: 20 },
      recovery: { recovery: 10 },
      power: { damagePercent: 10 },
    },
    ...overrides,
  };
}

/** Applies run actions in order, collecting every event. */
export function play(state: RunState, ...actions: RunAction[]): { state: RunState; events: Array<GameEvent | RunEvent>; last: RunStepResult } {
  const events: Array<GameEvent | RunEvent> = [];
  let current = state;
  let last: RunStepResult | undefined;
  for (const action of actions) {
    last = step(current, action);
    current = last.state;
    events.push(...last.events);
  }
  return { state: current, events, last: last as RunStepResult };
}

/**
 * Wins the current fight: lets the first stream arrive, then on the next turn strikes the shielded value with exactly its
 * true count (a perfect Frequency strike), which the weak test enemy cannot survive.
 */
export function winFight(state: RunState): { state: RunState; events: Array<GameEvent | RunEvent> } {
  const events: Array<GameEvent | RunEvent> = [];
  let current = state;
  const send = (action: RunAction) => {
    const result = step(current, action);
    current = result.state;
    events.push(...result.events);
  };
  send({ type: "endDeploy" });
  send({ type: "endDeploy" });
  const truth = groundTruth(current.fight as NonNullable<RunState["fight"]>);
  send({ type: "strikeValue", value: truth.frequency?.count ?? 1 });
  return { state: current, events };
}
