import type { StructureConstants } from "@pda/engine";
import { z } from "zod";
import balanceJson from "../balance.json";

/** Every capitalized constant in the spec. All values are placeholders until the simulator tunes them. */
export const balanceSchema = z.object({
  VALUE_BITS: z.number().int().positive(),
  CONFIDENCE: z.number().gt(0).lt(1),

  STARTING_SPACE: z.number().int().positive(),
  STARTING_CERTAINTY: z.number().int().positive(),
  STARTING_SLOTS: z.number().int().positive(),
  REST_HEAL: z.number().int().nonnegative(),

  BASE: z.number().positive(),
  HIT_DAMAGE: z.number().positive(),
  DECOY_PENALTY: z.number().nonnegative(),
  BLOCK_PENALTY: z.number().nonnegative(),
  MISS_PENALTY: z.number().nonnegative(),
  OVERSHOOT_EXP: z.number().positive(),
  COUNT_TOL: z.number().positive(),
  RANK_TOL: z.number().positive(),

  PRESENCE_TARGETS: z.number().int().positive(),
  LIKENESS_COPIES: z.number().int().positive(),
  LIKE_THRESHOLD: z.number().gt(0).lt(1),

  CUNNING_SEARCH: z.number().int().positive(),
});

export type Balance = z.infer<typeof balanceSchema>;

export function parseBalance(raw: unknown): Balance {
  return balanceSchema.strict().parse(raw);
}

/** Balance as validated at load time. Throws if balance.json is malformed. */
export const balance: Balance = parseBalance(balanceJson);

/** The slice of balance the engine's structures need, passed in because the engine imports no other package. */
export function structureConstants(b: Balance = balance): StructureConstants {
  return { valueBits: b.VALUE_BITS, confidence: b.CONFIDENCE };
}
