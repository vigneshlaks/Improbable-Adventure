import type { FightConfig, FightRules, StructureKind } from "@pda/engine";
import { balance, structureConstants, type Balance } from "./balance";
import { generateEnemy, type TierName } from "./enemies";
import { traits as defaultTraits, type Traits } from "./traits";

export interface FightOptions {
  seed: string;
  tier: TierName;
  /** The structures the player may deploy. Defaults to the starting loadout. */
  loadout?: StructureKind[];
  tuning?: Balance;
  traitData?: Traits;
}

/** The rules of a fight, from the tuning numbers. */
export function fightRules(tuning: Balance = balance): FightRules {
  return {
    startingSpace: tuning.STARTING_SPACE,
    startingCertainty: tuning.STARTING_CERTAINTY,
    startingSlots: tuning.STARTING_SLOTS,
    base: tuning.BASE,
    hitDamage: tuning.HIT_DAMAGE,
    decoyPenalty: tuning.DECOY_PENALTY,
    blockPenalty: tuning.BLOCK_PENALTY,
    missPenalty: tuning.MISS_PENALTY,
    overshootExp: tuning.OVERSHOOT_EXP,
    countTol: tuning.COUNT_TOL,
    rankTol: tuning.RANK_TOL,
    presenceTargets: tuning.PRESENCE_TARGETS,
    likeCopies: tuning.LIKENESS_COPIES,
    likeThreshold: tuning.LIKE_THRESHOLD,
    likeMinSet: tuning.LIKE_MIN_SET,
    likeMaxSet: tuning.LIKE_MAX_SET,
    likeRealMin: tuning.LIKE_REAL_BAND.min,
    likeRealMax: tuning.LIKE_REAL_BAND.max,
    cunningSearch: tuning.CUNNING_SEARCH,
    expectedTurns: tuning.EXPECTED_TURNS,
    turnLimitPenalty: tuning.TURN_LIMIT_PENALTY,
    changesPerSlot: tuning.DEPLOY_CHANGES_PER_SLOT,
  };
}

/** Everything the engine needs to start a fight: the rules, the player's loadout, and a generated enemy. */
export function buildFightConfig(options: FightOptions): FightConfig {
  const { seed, tier, tuning = balance, traitData = defaultTraits } = options;
  return {
    constants: structureConstants(tuning),
    rules: fightRules(tuning),
    loadout: options.loadout ?? [...tuning.STARTING_LOADOUT],
    enemy: generateEnemy(seed, tier, tuning, traitData),
    traitTables: traitData.levels,
  };
}
