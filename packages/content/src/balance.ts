import { STRUCTURE_KINDS, type StructureConstants } from "@pda/engine";
import { z } from "zod";
import balanceJson from "../balance.json";

/** An inclusive whole-number range such as "1 to 2 traits". */
const rangeSchema = (largest: number) =>
  z
    .object({ min: z.number().int().min(1), max: z.number().int().max(largest) })
    .strict()
    .refine((range) => range.min <= range.max, { message: "min must not exceed max" });

/** How tough an enemy tier is. All numbers are placeholders until the simulator tunes them. */
const tierSchema = z
  .object({
    size: z.number().int().positive(),
    hp: z.number().positive(),
    attack: z.number().nonnegative(),
    turnLimit: z.number().int().positive(),
    /** How many of the five stream traits are above Low. */
    traitCount: rangeSchema(5),
    /** How many weak points the enemy has. */
    weakPointCount: rangeSchema(3),
    /** The chance that a trait above Low is High instead of Medium. */
    highChance: z.number().min(0).max(1),
  })
  .strict();

/** Every capitalized constant in the spec. All values are placeholders until the simulator tunes them. */
export const balanceSchema = z.object({
  VALUE_BITS: z.number().int().positive(),
  CONFIDENCE: z.number().gt(0).lt(1),
  CMS_DEFAULT_DEPTH: z.number().int().positive(),
  LOGLOG_ERROR_COEFFICIENT: z.number().positive(),
  HLL_ERROR_COEFFICIENT: z.number().positive(),
  HLL_SMALL_RANGE: z.number().positive(),
  STEADY_SPACE_COST: z.number().nonnegative(),
  SUPERLOGLOG_ERROR_COEFFICIENT: z.number().positive(),
  FADING_CELL_BITS: z.number().int().min(2).max(8),
  FADING_WINDOW: z.number().positive(),
  LIGHT_COUNTER_BITS: z.number().int().min(2).max(31),
  LIGHT_REGISTER_BITS: z.number().int().min(2).max(5),
  /** The relative error the exporter sizes for when the player leaves the target blank. */
  COUNT_SKETCH_DEFAULT_DEPTH: z.number().int().positive(),
  TOPK_SHARE: z.number().gt(0).lt(1),
  CUCKOO_BUCKET_SIZE: z.number().int().positive(),
  CUCKOO_FINGERPRINT_BITS: z.number().int().min(1).max(16),
  CUCKOO_MAX_KICKS: z.number().int().positive(),
  KLL_RANK_ERROR: z.number().positive(),
  TDIGEST_RANK_ERROR: z.number().positive(),
  EXPORT_DEFAULT_ERROR: z.number().gt(0).lt(1),
  /** How a step is scored for reinforcement learning: a reward for each enemy beaten, and costs per turn, per Certainty lost and for losing the run. */
  RL_REWARD: z.object({ enemyDefeated: z.number(), perTurn: z.number().nonnegative(), perCertaintyLost: z.number().nonnegative(), runLoss: z.number().nonnegative() }).strict(),
  /** The most deploy slots the learning agent's action table addresses (slots past this are never offered to it). */
  RL_MAX_SLOTS: z.number().int().positive(),
  /** Steps after which a learning episode is cut off, so an agent that never ends a turn cannot run forever. */
  RL_MAX_STEPS: z.number().int().positive(),

  STARTING_SPACE: z.number().int().positive(),
  STARTING_CERTAINTY: z.number().int().positive(),
  STARTING_SLOTS: z.number().int().positive(),
  STARTING_LOADOUT: z.array(z.enum(STRUCTURE_KINDS)).min(1),
  REST_HEAL: z.number().int().nonnegative(),
  /** The act, in the order the enemies are fought. */
  RUN_ENCOUNTERS: z.array(z.enum(["minion", "elite", "boss"])).min(1),
  /** Encounter numbers (counting from 0) that are preceded by a rest stop. */
  REST_BEFORE: z.array(z.number().int().min(1)),
  /** How many rewards are offered after a fight. */
  REWARD_CHOICES: z.number().int().positive(),
  /** Deploys and removals allowed in a turn, per slot: both are free, so without a limit a fight could go on for ever. */
  DEPLOY_CHANGES_PER_SLOT: z.number().int().positive(),
  /** Enchantments that may be attached or moved at one rest stop, for the same reason. */
  REST_ENCHANT_LIMIT: z.number().int().nonnegative(),
  /** How likely each kind of reward is to be drawn, relative to the others. */
  REWARD_WEIGHTS: z.object({ structure: z.number().nonnegative(), upgrade: z.number().nonnegative(), enchantment: z.number().nonnegative() }).strict(),

  BASE: z.number().positive(),
  HIT_DAMAGE: z.number().positive(),
  DECOY_PENALTY: z.number().nonnegative(),
  BLOCK_PENALTY: z.number().nonnegative(),
  MISS_PENALTY: z.number().nonnegative(),
  OVERSHOOT_EXP: z.number().positive(),
  COUNT_TOL: z.number().positive(),
  RANK_TOL: z.number().positive(),
  /** The quantiles an enemy of each tier may put its Rank armor at. */
  RANK_QUANTILES: z.object({ minion: z.array(z.number().gt(0).lt(1)).min(1), elite: z.array(z.number().gt(0).lt(1)).min(1), boss: z.array(z.number().gt(0).lt(1)).min(1) }).strict(),

  PRESENCE_TARGETS: z.number().int().positive(),
  LIKENESS_COPIES: z.number().int().positive(),
  LIKE_THRESHOLD: z.number().gt(0).lt(1),

  CUNNING_SEARCH: z.number().int().positive(),

  EXPECTED_TURNS: z.number().int().positive(),
  TURN_LIMIT_PENALTY: z.number().nonnegative(),

  TIERS: z.object({ minion: tierSchema, elite: tierSchema, boss: tierSchema }).strict(),
});

export type Balance = z.infer<typeof balanceSchema>;

export function parseBalance(raw: unknown): Balance {
  return balanceSchema.strict().parse(raw);
}

/** Balance as validated at load time. Throws if balance.json is malformed. */
export const balance: Balance = parseBalance(balanceJson);

/** The slice of balance the engine's structures need, passed in because the engine imports no other package. */
export function structureConstants(b: Balance = balance): StructureConstants {
  return {
    valueBits: b.VALUE_BITS,
    confidence: b.CONFIDENCE,
    cmsDefaultDepth: b.CMS_DEFAULT_DEPTH,
    logLogErrorCoefficient: b.LOGLOG_ERROR_COEFFICIENT,
    hyperLogLogErrorCoefficient: b.HLL_ERROR_COEFFICIENT,
    hyperLogLogSmallRange: b.HLL_SMALL_RANGE,
    steadySpaceCost: b.STEADY_SPACE_COST,
    superLogLogErrorCoefficient: b.SUPERLOGLOG_ERROR_COEFFICIENT,
    fadingCellBits: b.FADING_CELL_BITS,
    fadingWindow: b.FADING_WINDOW,
    lightCounterBits: b.LIGHT_COUNTER_BITS,
    lightRegisterBits: b.LIGHT_REGISTER_BITS,
    countSketchDefaultDepth: b.COUNT_SKETCH_DEFAULT_DEPTH,
    topKShare: b.TOPK_SHARE,
    cuckooBucketSize: b.CUCKOO_BUCKET_SIZE,
    cuckooFingerprintBits: b.CUCKOO_FINGERPRINT_BITS,
    cuckooMaxKicks: b.CUCKOO_MAX_KICKS,
    kllRankError: b.KLL_RANK_ERROR,
    tdigestRankError: b.TDIGEST_RANK_ERROR,
  };
}
