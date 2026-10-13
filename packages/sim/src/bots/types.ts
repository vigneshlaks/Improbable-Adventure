import type { Action, GroundTruth, Observation, Rng, StructureKind } from "@pda/engine";

/** Everything a bot is allowed to know when it chooses an action. */
export interface BotView {
  /** What a player can see. */
  observation: Observation;
  /** The structures the player owns. */
  loadout: readonly StructureKind[];
  /** The engine's representative list of legal actions, computed only if asked for. */
  legalActions: () => Action[];
  /** The true answers. Null for every bot except the ones that declare `usesTruth`. */
  truth: GroundTruth | null;
}

/** Chooses the next action. A new player is made for each fight, so it may remember things as it goes. */
export type BotPlayer = (view: BotView, rng: Rng) => Action;

export interface Bot {
  name: string;
  /** One line on how it plays and why it exists. */
  description: string;
  /** Whether the runner should show it the true answers. Only the Oracle does. */
  usesTruth: boolean;
  create(): BotPlayer;
}
