import type { LiveSnapshot } from "../enemies/liveSet";
import type { StreamState, StreamTraits, TraitTables } from "../enemies/stream";
import type { RngState } from "../rng/rng";
import type {
  Answer,
  Challenge,
  StructureConstants,
  StructureKind,
  StructureSnapshot,
} from "../structures/types";
import type { TrueAnswer, WeakPoint } from "./challenges";
import type { DamageRules, StrikeResult } from "./damage";

/** Everything the rules of one fight need, as plain numbers. Built from `balance.json` and the content files. */
export interface FightRules extends DamageRules {
  startingSpace: number;
  startingCertainty: number;
  startingSlots: number;
  /** Targets shown in a Presence challenge. */
  presenceTargets: number;
  /** Bursts are sized so the stream totals the enemy's Size over this many turns. */
  expectedTurns: number;
  /** Certainty lost when the fight reaches its turn limit. */
  turnLimitPenalty: number;
  /** Multiplies the damage of every strike. A run sets it from the Power upgrade; a plain fight leaves it at 1. */
  damageMultiplier?: number;
}

export interface EnemyConfig {
  tier: "minion" | "elite" | "boss";
  /** Total events the stream is sized to emit. */
  size: number;
  hp: number;
  /** Certainty the enemy takes at the end of every turn. */
  attack: number;
  turnLimit: number;
  traits: StreamTraits;
  weakPoints: WeakPoint[];
}

/** How a step is scored for reinforcement learning. Ignored by the game itself. */
export interface RewardWeights {
  enemyDefeated: number;
  perTurn: number;
  perCertaintyLost: number;
  runLoss: number;
}

export interface FightConfig {
  constants: StructureConstants;
  rules: FightRules;
  /** The structure kinds the player owns and may deploy. */
  loadout: StructureKind[];
  /** The enchantment attached to each kind of structure, by id. A run sets it; a plain fight leaves it out. */
  enchantments?: Partial<Record<StructureKind, string>>;
  enemy: EnemyConfig;
  traitTables: TraitTables;
  /** Defaults to the spec's starting values. */
  rewards?: RewardWeights;
}

export type Phase = "deploy" | "strike" | "won" | "lost";

/**
 * The whole fight as plain data: it survives JSON unchanged, and `step` returns a new one without touching
 * the old. Deployed structures are stored as snapshots and rebuilt when needed.
 */
export interface FightState {
  config: FightConfig;
  seed: string;
  phase: Phase;
  turn: number;
  certainty: number;
  enemyHp: number;
  /** One entry per slot: a structure snapshot, or null when empty. */
  slots: Array<StructureSnapshot | null>;
  stream: StreamState;
  live: LiveSnapshot;
  challengeRng: RngState;
  /** The open challenge during the strike phase, otherwise null. */
  challenge: Challenge | null;
  /** The weak point, once the first challenge has revealed it. */
  weakPoint: WeakPoint | null;
}

export type Action =
  | { type: "deploy"; slot: number; kind: StructureKind; spaceBits: number; knob?: number }
  | { type: "remove"; slot: number }
  | { type: "endDeploy" }
  | { type: "strikeSubset"; targets: number[] }
  | { type: "strikeValue"; value: number };

export type GameEvent =
  | { type: "structureDeployed"; slot: number; kind: StructureKind; spaceBits: number }
  | { type: "structureRemoved"; slot: number; kind: StructureKind; spaceBits: number }
  | { type: "burstIngested"; turn: number; events: number; inserts: number; deletes: number }
  | { type: "challengeIssued"; turn: number; weakPoint: WeakPoint; challenge: Challenge; firstReveal: boolean }
  | ({ type: "strikeResolved"; turn: number } & StrikeResult)
  | { type: "enemyAttacked"; turn: number; damage: number }
  | { type: "turnStarted"; turn: number }
  | { type: "fightWon"; turn: number }
  | { type: "fightLost"; turn: number; reason: "turnLimit" | "certainty"; certaintyLost: number };

export interface StepResult {
  state: FightState;
  events: GameEvent[];
  /** Used for reinforcement learning; ignored by the game. */
  reward: number;
  /** True once the fight is won or lost. */
  done: boolean;
}

/** One deployed structure as the player sees it. */
export interface StructureView {
  slot: number;
  kind: StructureKind;
  params: Readonly<Record<string, number>>;
  spaceBits: number;
  /** The enchantment it was built with, if any. */
  enchantment?: string;
  /** The structure's answer to the open challenge, or null when it cannot answer or there is none. */
  answer: Answer | null;
}

/** Everything the player may see. The true answers are not included. */
export interface Observation {
  turn: number;
  phase: Phase;
  certainty: number;
  enemyHp: number;
  spaceFree: number;
  slotsFree: number;
  traits: StreamTraits;
  weakPoint: WeakPoint | null;
  challenge: Challenge | null;
  structures: StructureView[];
}

/** The real answers, for bots and tests. Never part of an Observation. */
export interface GroundTruth {
  frequency: { value: number; count: number } | null;
  distinct: number;
  /** The true answer to the open challenge, or null when no challenge is open. */
  answer: TrueAnswer | null;
}

/** Thrown when an action is not allowed in the current state. */
export class IllegalActionError extends RangeError {}
