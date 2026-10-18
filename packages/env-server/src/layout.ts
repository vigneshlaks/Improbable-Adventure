import { STRUCTURE_KINDS, type RunConfig, type StructureKind } from "@pda/engine";

/** The shares of the free Space a deploy action offers. The engine lists deploy options at the same shares. */
export const DEPLOY_SHARES = [0.25, 0.5, 0.75, 1] as const;

/** How a strike is chosen from what the structures say. The ones with a slot use that slot's structure. */
export type StrikeKind = "flaggedAll" | "confirmed" | "none" | "flaggedBy" | "estimate" | "high" | "low" | "force1";

/** What one index of the action space means. */
export type ActionSpec =
  | { type: "endDeploy" }
  | { type: "remove"; slot: number }
  | { type: "deploy"; slot: number; kind: StructureKind; share: number }
  | { type: "strike"; how: StrikeKind; slot?: number }
  | { type: "choose"; index: number }
  | { type: "fuse"; recipeId: string }
  | { type: "enchant"; enchantmentId: string; kind: StructureKind }
  | { type: "leave" };

/**
 * The fixed shape of the learning problem for one rule set: which index is which action, and how long the
 * observation vector is. Built from a run config's vocabulary (rewards, upgrades, fusions, enchantments), not from its
 * seed, so every seed of the same content gives the same layout.
 */
export interface Layout {
  slots: number;
  kinds: readonly StructureKind[];
  rewardIds: string[];
  upgradeIds: string[];
  fusionIds: string[];
  enchantmentIds: string[];
  rewardChoices: number;
  actions: ActionSpec[];
  /** A readable name for each action index. */
  labels: string[];
  observationSize: number;
}

/** Floats per deployed-structure slot in the observation. */
export const SLOT_FEATURES = 1 + STRUCTURE_KINDS.length + 1 + 6;

/** Floats that do not depend on the vocabulary: run, tier, owned and attached structures, traits, weak point, challenge. */
const FIXED_FEATURES = 3 + 3 + 3 + STRUCTURE_KINDS.length * 2 + 3 + 3 + 1 + 5 + 4 + 3 + 3;

function actionLabel(spec: ActionSpec): string {
  switch (spec.type) {
    case "endDeploy":
      return "end deploy";
    case "remove":
      return `remove slot ${spec.slot + 1}`;
    case "deploy":
      return `deploy ${spec.kind} in slot ${spec.slot + 1} with ${spec.share * 100}% of the free Space`;
    case "strike":
      return `strike ${spec.how}${spec.slot === undefined ? "" : ` of slot ${spec.slot + 1}`}`;
    case "choose":
      return `choose reward ${spec.index + 1}`;
    case "fuse":
      return `fuse ${spec.recipeId}`;
    case "enchant":
      return `attach ${spec.enchantmentId} to ${spec.kind}`;
    case "leave":
      return "leave the rest stop";
  }
}

export function buildLayout(config: RunConfig, maxSlots: number): Layout {
  const slots = maxSlots;
  const kinds = STRUCTURE_KINDS;
  const actions: ActionSpec[] = [{ type: "endDeploy" }];
  for (let slot = 0; slot < slots; slot++) actions.push({ type: "remove", slot });
  for (const kind of kinds) for (let slot = 0; slot < slots; slot++) for (const share of DEPLOY_SHARES) actions.push({ type: "deploy", slot, kind, share });
  for (const how of ["flaggedAll", "confirmed", "none", "force1"] as const) actions.push({ type: "strike", how });
  for (const how of ["flaggedBy", "estimate", "high", "low"] as const) for (let slot = 0; slot < slots; slot++) actions.push({ type: "strike", how, slot });
  for (let index = 0; index < config.rewardChoices; index++) actions.push({ type: "choose", index });
  const fusionIds = config.fusions.map((fusion) => fusion.id).sort();
  for (const recipeId of fusionIds) actions.push({ type: "fuse", recipeId });
  const enchantmentIds = config.enchantments.map((enchantment) => enchantment.id).sort();
  for (const enchantmentId of enchantmentIds) for (const kind of kinds) if (config.enchantments.find((e) => e.id === enchantmentId)?.valid.includes(kind)) actions.push({ type: "enchant", enchantmentId, kind });
  actions.push({ type: "leave" });

  const rewardIds = config.rewards.map((reward) => reward.id).sort();
  const upgradeIds = Object.keys(config.upgrades).sort();
  const observationSize =
    FIXED_FEATURES +
    upgradeIds.length +
    enchantmentIds.length + // enchantments held, by id
    slots * SLOT_FEATURES +
    config.rewardChoices * (1 + rewardIds.length) +
    fusionIds.length +
    actions.filter((action) => action.type === "enchant").length;

  return { slots, kinds, rewardIds, upgradeIds, fusionIds, enchantmentIds, rewardChoices: config.rewardChoices, actions, labels: actions.map(actionLabel), observationSize };
}
