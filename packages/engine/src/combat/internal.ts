import { LiveSet } from "../enemies/liveSet";
import { resolveStreamParams, type StreamParams } from "../enemies/stream";
import { Rng } from "../rng/rng";
import { createStructure, restoreStructure } from "../structures";
import type { Structure } from "../structures/types";
import {
  IllegalActionError,
  type Action,
  type FightConfig,
  type FightState,
  type RewardWeights,
} from "./types";

// Helpers shared by the fight's step function and its read-only views.

/** The enchantment that gives a structure a secret hash seed for the fight. */
export const SEEDED = "seeded";

/** The spec's starting reward weights. */
export const DEFAULT_REWARDS: RewardWeights = { enemyDefeated: 1, perTurn: 0.01, perCertaintyLost: 0.005, runLoss: 1 };

export function streamParamsOf(config: FightConfig): StreamParams {
  return resolveStreamParams(config.enemy.size, config.enemy.traits, config.traitTables, config.rules.expectedTurns);
}

export function liveSetOf(state: FightState): LiveSet {
  return LiveSet.fromSnapshot(state.live);
}

/** Space assigned to deployed structures is charged in full, even if a structure rounds its size down. */
export function spaceFree(state: FightState): number {
  return state.config.rules.startingSpace - state.slots.reduce((sum, slot) => sum + (slot?.spaceBits ?? 0), 0);
}

export function slotsFree(state: FightState): number {
  return state.slots.filter((slot) => slot === null).length;
}

/** Rebuilds the live structure in every slot (null for an empty slot). */
export function loadStructures(state: FightState): Array<Structure | null> {
  return state.slots.map((snapshot) => (snapshot ? restoreStructure(snapshot, state.config.constants) : null));
}

type DeployAction = Extract<Action, { type: "deploy" }>;

/** Builds the structure a deploy action asks for. Each gets its own random stream, derived from the seed. */
export function buildStructure(state: FightState, action: DeployAction): Structure {
  const rng = Rng.fromSeed(`${state.seed}/structure/${state.turn}/${action.slot}`);
  const enchantment = state.config.enchantments?.[action.kind];
  return createStructure(
    action.kind,
    {
      spaceBits: action.spaceBits,
      ...(action.knob !== undefined ? { knob: action.knob } : {}),
      rng,
      ...(enchantment !== undefined ? { enchantment } : {}),
      // Seeded: a hash seed nobody could know before the fight, from the structure's own stream so no other stream shifts.
      ...(enchantment === SEEDED ? { hashSeed: rng.split("hash").next() } : {}),
    },
    state.config.constants,
  );
}

/** Why a deploy action is not allowed, or null if it is. `step` and `legalActions` share this check. */
export function deployProblem(state: FightState, action: DeployAction): string | null {
  if (state.phase !== "deploy") return "Structures can only be deployed during the deploy phase";
  if (!Number.isInteger(action.slot) || action.slot < 0 || action.slot >= state.slots.length) return `There is no slot ${action.slot}`;
  if (state.slots[action.slot] !== null) return `Slot ${action.slot} is already in use`;
  if (!state.config.loadout.includes(action.kind)) return `You do not own a ${action.kind}`;
  if (!Number.isInteger(action.spaceBits) || action.spaceBits < 1) return "Space must be a whole number of bits";
  if (action.spaceBits > spaceFree(state)) return `Only ${spaceFree(state)} bits of Space are free`;
  if (action.knob !== undefined && !Number.isFinite(action.knob)) return "The knob must be a finite number";
  try {
    buildStructure(state, action);
  } catch (error) {
    return error instanceof RangeError ? error.message : "The structure cannot be built";
  }
  return null;
}

export function assertDeploy(state: FightState, action: DeployAction): void {
  const problem = deployProblem(state, action);
  if (problem) throw new IllegalActionError(problem);
}
