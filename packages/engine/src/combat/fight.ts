import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, outsideValue, type StreamParams } from "../enemies/stream";
import { Rng } from "../rng/rng";
import { gradeStrike, issueChallenge, type ChallengeContext } from "./challenges";
import { settle } from "./damage";
import {
  assertDeploy,
  buildStructure,
  changesLeft,
  CHANGES_USED_UP,
  DEFAULT_REWARDS,
  liveSetOf,
  loadStructures,
  streamParamsOf,
} from "./internal";
import {
  IllegalActionError,
  type Action,
  type FightConfig,
  type FightState,
  type GameEvent,
  type StepResult,
} from "./types";

/** How many distinct never-inserted decoy values a Presence challenge can draw from. */
const OUTSIDE_VALUE_RANGE = 2 ** 30;

function validateConfig(config: FightConfig): void {
  const { rules, enemy, loadout } = config;
  const need = (ok: boolean, message: string) => {
    if (!ok) throw new RangeError(`Bad fight config: ${message}`);
  };
  need(rules.startingSlots >= 1 && Number.isInteger(rules.startingSlots), "startingSlots must be a whole number >= 1");
  need(rules.startingSpace >= 1, "startingSpace must be positive");
  need(rules.startingCertainty > 0, "startingCertainty must be positive");
  need(rules.expectedTurns >= 1, "expectedTurns must be >= 1");
  need(Number.isInteger(rules.changesPerSlot) && rules.changesPerSlot >= 1, "changesPerSlot must be a whole number >= 1");
  need(enemy.hp > 0, "enemy hp must be positive");
  need(enemy.turnLimit >= 1 && Number.isInteger(enemy.turnLimit), "turnLimit must be a whole number >= 1");
  need(enemy.weakPoints.length >= 1, "an enemy needs at least one weak point");
  if (enemy.weakPoints.includes("rank")) {
    need(enemy.rankQuantile !== undefined && enemy.rankQuantile > 0 && enemy.rankQuantile < 1, "an enemy with the Rank weak point needs a rankQuantile between 0 and 1");
  }
  need(loadout.length >= 1, "the loadout cannot be empty");
}

/** Starts a fight on turn 1, in the deploy phase, with every slot empty. */
export function createFight(seed: string, config: FightConfig): FightState {
  validateConfig(config);
  return {
    config,
    seed,
    phase: "deploy",
    turn: 1,
    certainty: config.rules.startingCertainty,
    enemyHp: config.enemy.hp,
    slots: Array.from({ length: config.rules.startingSlots }, () => null),
    stream: createStream(seed),
    live: new LiveSet().snapshot(),
    challengeRng: Rng.fromSeed(`${seed}/challenge`).getState(),
    challenge: null,
    weakPoint: null,
    changes: 0,
  };
}

/** Bookkeeping for the reward: what happened during one step. */
interface Tally {
  certaintyLost: number;
  turnEnded: boolean;
  won: boolean;
  runLost: boolean;
}

function loseCertainty(state: FightState, amount: number, tally: Tally): void {
  if (amount <= 0) return;
  const before = state.certainty;
  state.certainty = Math.max(0, settle(state.certainty - amount));
  tally.certaintyLost += before - state.certainty;
}

function endFightLost(state: FightState, events: GameEvent[], reason: "turnLimit" | "certainty", penalty: number, tally: Tally): void {
  state.phase = "lost";
  state.challenge = null;
  if (state.certainty <= 0) {
    reason = "certainty"; // the run is over, whatever caused it
    tally.runLost = true;
  }
  events.push({ type: "fightLost", turn: state.turn, reason, certaintyLost: penalty });
}

/** The enemy attacks, then the fight either ends (Certainty gone, or the turn limit) or the next turn begins. */
function finishTurn(state: FightState, events: GameEvent[], tally: Tally): void {
  state.challenge = null;
  tally.turnEnded = true;

  const damage = state.config.enemy.attack;
  loseCertainty(state, damage, tally);
  events.push({ type: "enemyAttacked", turn: state.turn, damage });
  if (state.certainty <= 0) return endFightLost(state, events, "certainty", 0, tally);

  if (state.turn >= state.config.enemy.turnLimit) {
    const penalty = state.config.rules.turnLimitPenalty;
    loseCertainty(state, penalty, tally);
    return endFightLost(state, events, "turnLimit", penalty, tally);
  }

  state.turn += 1;
  state.phase = "deploy";
  state.changes = 0;
  events.push({ type: "turnStarted", turn: state.turn });
}

function challengeContext(state: FightState, params: StreamParams): ChallengeContext {
  const range = Math.min(OUTSIDE_VALUE_RANGE, 2 ** 32 - params.universe);
  return {
    presenceTargets: state.config.rules.presenceTargets,
    drawOutsideValue: (rng) => outsideValue(params, state.seed, rng.int(range)),
    rankQuantile: state.config.enemy.rankQuantile ?? 0.5,
    likeness: {
      copies: state.config.rules.likeCopies,
      threshold: state.config.rules.likeThreshold,
      minSet: state.config.rules.likeMinSet,
      maxSet: state.config.rules.likeMaxSet,
      realMin: state.config.rules.likeRealMin,
      realMax: state.config.rules.likeRealMax,
      decoyMin: state.config.traitTables.likeness[state.config.enemy.traits.likeness].min,
      decoyMax: state.config.traitTables.likeness[state.config.enemy.traits.likeness].max,
    },
  };
}

/** Ingest: the enemy emits a burst, every deployed structure sees it, and from turn 2 a challenge follows. */
function endDeploy(state: FightState, events: GameEvent[], tally: Tally): void {
  const params = streamParamsOf(state.config);
  const live = liveSetOf(state);
  const burst = nextBurst(params, state.stream, live);

  // A structure only learns what streams while it is deployed.
  const structures = loadStructures(state);
  for (const event of burst.events) for (const structure of structures) structure?.ingest(event);
  state.slots = structures.map((structure) => (structure ? structure.snapshot() : null));
  state.stream = burst.state;
  state.live = live.snapshot();

  const deletes = burst.events.filter((event) => event.op === "delete").length;
  events.push({ type: "burstIngested", turn: state.turn, events: burst.events.length, inserts: burst.events.length - deletes, deletes });

  if (state.turn >= 2) {
    const weakPoints = state.config.enemy.weakPoints;
    const weakPoint = weakPoints[(state.turn - 2) % weakPoints.length] as (typeof weakPoints)[number];
    const rng = Rng.fromState(state.challengeRng);
    const challenge = issueChallenge(weakPoint, live, rng, challengeContext(state, params));
    state.challengeRng = rng.getState();

    if (challenge) {
      const firstReveal = state.weakPoint === null;
      state.weakPoint = weakPoint;
      state.challenge = challenge;
      state.phase = "strike";
      events.push({ type: "challengeIssued", turn: state.turn, weakPoint, challenge, firstReveal });
      return;
    }
  }
  finishTurn(state, events, tally);
}

function strike(state: FightState, action: Extract<Action, { type: "strikeSubset" | "strikeValue" }>, events: GameEvent[], tally: Tally): void {
  if (state.phase !== "strike" || !state.challenge) throw new IllegalActionError("There is no challenge to strike");

  const input = action.type === "strikeSubset" ? { targets: action.targets } : { value: action.value };
  let result;
  try {
    result = gradeStrike(state.challenge, liveSetOf(state), input, state.config.rules);
  } catch (error) {
    throw new IllegalActionError(error instanceof Error ? error.message : "Invalid strike");
  }
  const multiplier = state.config.rules.damageMultiplier ?? 1;
  if (multiplier !== 1) result = { ...result, damage: settle(result.damage * multiplier) };

  state.enemyHp = Math.max(0, settle(state.enemyHp - result.damage));
  loseCertainty(state, result.certaintyLost, tally);
  events.push({ type: "strikeResolved", turn: state.turn, ...result });

  // Running out of Certainty ends the run even if the same strike finished the enemy.
  if (state.certainty <= 0) {
    endFightLost(state, events, "certainty", 0, tally);
  } else if (state.enemyHp <= 0) {
    state.phase = "won";
    state.challenge = null;
    tally.won = true;
    events.push({ type: "fightWon", turn: state.turn });
  } else {
    finishTurn(state, events, tally);
  }
}

/**
 * Applies one action and returns the new state plus what happened. The input state is not modified.
 * Throws an IllegalActionError for an action that is not allowed right now.
 */
export function step(state: FightState, action: Action): StepResult {
  if (state.phase === "won" || state.phase === "lost") throw new IllegalActionError("The fight is over");

  // Nested parts of the state are replaced, never edited, so a shallow copy keeps the input untouched.
  const next: FightState = { ...state, slots: [...state.slots] };
  const events: GameEvent[] = [];
  const tally: Tally = { certaintyLost: 0, turnEnded: false, won: false, runLost: false };

  switch (action.type) {
    case "deploy": {
      assertDeploy(next, action);
      const structure = buildStructure(next, action);
      next.slots[action.slot] = structure.snapshot();
      next.changes += 1;
      events.push({ type: "structureDeployed", slot: action.slot, kind: action.kind, spaceBits: action.spaceBits });
      break;
    }
    case "remove": {
      if (next.phase !== "deploy") throw new IllegalActionError("Structures can only be removed during the deploy phase");
      const existing = next.slots[action.slot];
      if (!existing) throw new IllegalActionError(`Slot ${action.slot} is empty`);
      if (changesLeft(next) <= 0) throw new IllegalActionError(CHANGES_USED_UP);
      next.changes += 1;
      next.slots[action.slot] = null; // its Space is refunded and what it learned is discarded
      events.push({ type: "structureRemoved", slot: action.slot, kind: existing.kind, spaceBits: existing.spaceBits });
      break;
    }
    case "endDeploy":
      if (next.phase !== "deploy") throw new IllegalActionError("The deploy phase is over");
      endDeploy(next, events, tally);
      break;
    case "strikeSubset":
    case "strikeValue":
      strike(next, action, events, tally);
      break;
  }

  const weights = state.config.rewards ?? DEFAULT_REWARDS;
  let reward = -weights.perCertaintyLost * tally.certaintyLost;
  if (tally.turnEnded) reward -= weights.perTurn;
  if (tally.won) reward += weights.enemyDefeated;
  if (tally.runLost) reward -= weights.runLoss;

  return { state: next, events, reward, done: next.phase === "won" || next.phase === "lost" };
}
