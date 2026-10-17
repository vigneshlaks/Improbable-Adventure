import type { TraitTables } from "../enemies/stream";
import type { RngState } from "../rng/rng";
import type { StructureConstants, StructureKind } from "../structures/types";
import type { Action, EnemyConfig, FightRules, FightState, GameEvent, Observation } from "../combat/types";

/** What one level of an upgrade changes. Every field is optional and they add up across levels. */
export interface UpgradeEffect {
  /** Extra Space in every fight, in bits. */
  space?: number;
  /** Extra deploy slots. */
  slots?: number;
  /** Extra maximum Certainty; the current Certainty rises by the same amount when it is taken. */
  maxCertainty?: number;
  /** Certainty restored after each won fight. */
  recovery?: number;
  /** Extra damage on every strike, in percent. */
  damagePercent?: number;
}

/** An enchantment: which kinds of structure it can be attached to. What it does is built into those structures. */
export interface EnchantmentDef {
  id: string;
  valid: StructureKind[];
}

/** One thing that can be offered after a fight. `weight` is its share of the draw, and zero means never. */
export type RewardDef =
  | { id: string; kind: "structure"; structure: StructureKind; weight: number }
  | { id: string; kind: "upgrade"; upgrade: string; weight: number }
  | { id: string; kind: "enchantment"; enchantment: string; weight: number };

/** A recipe: owning every input lets the player fuse them, at a rest stop, into the result. The inputs are consumed. */
export interface FusionDef {
  id: string;
  inputs: StructureKind[];
  result: StructureKind;
}

/** Everything a run needs, as plain data. The content package builds it from the content files and the run seed. */
export interface RunConfig {
  constants: StructureConstants;
  /** The rules of a fight before upgrades: starting Space, slots and Certainty, and the damage numbers. */
  rules: FightRules;
  traitTables: TraitTables;
  /** The structures the player owns at the start. */
  loadout: StructureKind[];
  /** The enemies, in the order they are fought. The run is won by beating the last one. */
  encounters: EnemyConfig[];
  /** Encounter numbers (counting from 0) that are preceded by a rest stop. */
  restBefore: number[];
  /** Certainty restored at a rest stop. */
  restHeal: number;
  /** How many rewards are offered after a fight. */
  rewardChoices: number;
  rewards: RewardDef[];
  fusions: FusionDef[];
  enchantments: EnchantmentDef[];
  upgrades: Record<string, UpgradeEffect>;
}

export type RunPhase = "fight" | "reward" | "rest" | "won" | "lost";

/** The whole run as plain data: it survives JSON unchanged, and `step` returns a new one without touching the old. */
export interface RunState {
  config: RunConfig;
  seed: string;
  phase: RunPhase;
  /** The encounter being fought, or the one just beaten while choosing a reward. Counts from 0. */
  encounter: number;
  /** The fight in progress, or null between fights. */
  fight: FightState | null;
  certainty: number;
  maxCertainty: number;
  owned: StructureKind[];
  /** Structures used up by a fusion. They are never offered as rewards again. */
  consumed: StructureKind[];
  /** Enchantments taken and not attached to anything. */
  enchantments: string[];
  /** The enchantment attached to each owned kind of structure (one each), built into it in every later fight. */
  attached: Partial<Record<StructureKind, string>>;
  /** How many times each upgrade has been taken. */
  upgrades: Record<string, number>;
  /** Ids of the rewards on offer during the reward phase, otherwise null. */
  offers: string[] | null;
  rewardRng: RngState;
  /** Turns used in the fights already finished. */
  turnsDone: number;
}

export type RunAction =
  | Action
  | { type: "chooseReward"; index: number }
  | { type: "fuse"; recipeId: string }
  | { type: "enchant"; enchantmentId: string; kind: StructureKind }
  | { type: "leaveRest" };

export type RunEvent =
  | { type: "fightStarted"; encounter: number; encounters: number; tier: EnemyConfig["tier"] }
  | { type: "rewardOffered"; options: string[] }
  | { type: "rewardChosen"; id: string }
  | { type: "restStarted"; healed: number }
  | { type: "fused"; recipeId: string; inputs: StructureKind[]; result: StructureKind }
  | { type: "enchanted"; enchantmentId: string; kind: StructureKind; replaced: string | null }
  | { type: "runWon"; turns: number; certaintyLeft: number }
  | { type: "runLost"; encounter: number };

export interface RunStepResult {
  state: RunState;
  events: Array<GameEvent | RunEvent>;
  /** The reward for reinforcement learning, as in a fight; zero outside a fight. */
  reward: number;
  done: boolean;
}

/** One reward on offer, as the player sees it. */
export type RewardView =
  | { id: string; kind: "structure"; structure: StructureKind }
  | { id: string; kind: "upgrade"; upgrade: string }
  | { id: string; kind: "enchantment"; enchantment: string };

export interface RunObservation {
  phase: RunPhase;
  encounter: number;
  encounters: number;
  /** The tier of that encounter. */
  tier: EnemyConfig["tier"];
  certainty: number;
  maxCertainty: number;
  owned: StructureKind[];
  upgrades: Record<string, number>;
  /** The fight, while one is in progress. */
  fight: Observation | null;
  /** The rewards on offer, during the reward phase. */
  offers: RewardView[] | null;
  /** The fusions the player can do right now, during a rest stop. */
  fusions: FusionDef[] | null;
  /** Enchantments held and not attached. */
  enchantments: string[];
  /** The enchantment on each structure. */
  attached: Partial<Record<StructureKind, string>>;
  /** The attachments the player can make right now, during a rest stop. */
  enchantable: Array<{ enchantmentId: string; kind: StructureKind }> | null;
}
