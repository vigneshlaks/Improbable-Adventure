import { STRUCTURE_KINDS, type RewardDef, type RunConfig, type StructureKind } from "@pda/engine";
import { balance, structureConstants, type Balance } from "./balance";
import { enchantments as defaultEnchantments, type EnchantmentInfo } from "./enchantments";
import { generateEnemy } from "./enemies";
import { fusions as defaultFusions, type FusionInfo } from "./fusions";
import { fightRules } from "./fight";
import { traits as defaultTraits, type Traits } from "./traits";
import { upgrades as defaultUpgrades, type UpgradeInfo } from "./upgrades";

export interface RunOptions {
  seed: string;
  tuning?: Balance;
  traitData?: Traits;
  upgradeData?: Record<string, UpgradeInfo>;
  fusionData?: Record<string, FusionInfo>;
  enchantmentData?: Record<string, EnchantmentInfo>;
}

/**
 * Everything the engine needs to run an act: the enemies of the act (each designed from the run seed), the rules,
 * and the pool of rewards. Structures the player already owns are never offered; they are filtered when drawing.
 */
export function buildRunConfig({ seed, tuning = balance, traitData = defaultTraits, upgradeData = defaultUpgrades, fusionData = defaultFusions, enchantmentData = defaultEnchantments }: RunOptions): RunConfig {
  const fused = new Set(Object.values(fusionData).map((fusion) => fusion.result)); // made at a rest stop, never found
  const doubled = new Set(Object.values(fusionData).filter((fusion) => fusion.inputs[0] === fusion.inputs[1]).map((fusion) => fusion.inputs[0] as StructureKind));
  const rewards: RewardDef[] = [
    // A kind that fuses with itself can be found again, even a starting one, since the fusion needs two copies of it.
    ...STRUCTURE_KINDS.filter((kind) => !fused.has(kind) && (!tuning.STARTING_LOADOUT.includes(kind) || doubled.has(kind))).map(
      (structure): RewardDef => ({ id: `structure:${structure}`, kind: "structure", structure, weight: tuning.REWARD_WEIGHTS.structure }),
    ),
    ...Object.keys(upgradeData).sort().map((upgrade): RewardDef => ({ id: `upgrade:${upgrade}`, kind: "upgrade", upgrade, weight: tuning.REWARD_WEIGHTS.upgrade })),
    ...Object.keys(enchantmentData)
      .sort()
      .filter((id) => enchantmentData[id]?.reward)
      .map((enchantment): RewardDef => ({ id: `enchantment:${enchantment}`, kind: "enchantment", enchantment, weight: tuning.REWARD_WEIGHTS.enchantment })),
  ];
  return {
    constants: structureConstants(tuning),
    rules: fightRules(tuning),
    traitTables: traitData.levels,
    loadout: [...tuning.STARTING_LOADOUT],
    encounters: tuning.RUN_ENCOUNTERS.map((tier, index) => generateEnemy(`${seed}/encounter/${index}`, tier, tuning, traitData)),
    restBefore: [...tuning.REST_BEFORE],
    restHeal: tuning.REST_HEAL,
    rewardChoices: tuning.REWARD_CHOICES,
    restEnchantLimit: tuning.REST_ENCHANT_LIMIT,
    rewards,
    fusions: Object.entries(fusionData).map(([id, fusion]) => ({ id, inputs: [...fusion.inputs], result: fusion.result })),
    enchantments: Object.entries(enchantmentData).map(([id, info]) => ({ id, valid: [...info.valid] })),
    upgrades: Object.fromEntries(Object.entries(upgradeData).map(([id, info]) => [id, info.effect])),
  };
}
