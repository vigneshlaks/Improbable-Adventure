import { STRUCTURE_KINDS, type RewardDef, type RunConfig } from "@pda/engine";
import { balance, structureConstants, type Balance } from "./balance";
import { generateEnemy } from "./enemies";
import { fightRules } from "./fight";
import { traits as defaultTraits, type Traits } from "./traits";
import { upgrades as defaultUpgrades, type UpgradeInfo } from "./upgrades";

export interface RunOptions {
  seed: string;
  tuning?: Balance;
  traitData?: Traits;
  upgradeData?: Record<string, UpgradeInfo>;
}

/**
 * Everything the engine needs to run an act: the enemies of the act (each designed from the run seed), the rules,
 * and the pool of rewards. Structures the player already owns are never offered; they are filtered when drawing.
 */
export function buildRunConfig({ seed, tuning = balance, traitData = defaultTraits, upgradeData = defaultUpgrades }: RunOptions): RunConfig {
  const rewards: RewardDef[] = [
    ...STRUCTURE_KINDS.filter((kind) => !tuning.STARTING_LOADOUT.includes(kind)).map(
      (structure): RewardDef => ({ id: `structure:${structure}`, kind: "structure", structure, weight: tuning.REWARD_WEIGHTS.structure }),
    ),
    ...Object.keys(upgradeData).sort().map((upgrade): RewardDef => ({ id: `upgrade:${upgrade}`, kind: "upgrade", upgrade, weight: tuning.REWARD_WEIGHTS.upgrade })),
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
    rewards,
    upgrades: Object.fromEntries(Object.entries(upgradeData).map(([id, info]) => [id, info.effect])),
  };
}
