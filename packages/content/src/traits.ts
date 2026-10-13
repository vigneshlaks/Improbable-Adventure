import type { StreamTraits, TraitTables, WeakPoint } from "@pda/engine";
import { z } from "zod";
import traitsJson from "../traits.json";

const perLevel = <T extends z.ZodType>(schema: T) => z.object({ low: schema, medium: schema, high: schema }).strict();

const weight = z.number().positive();
/** Extra weight a trait level gives to each weak point. */
const hintSchema = z.object({ presence: weight.optional(), frequency: weight.optional(), count: weight.optional() }).strict();
const traitHints = z.object({ medium: hintSchema.optional(), high: hintSchema.optional() }).strict();

export const traitsSchema = z
  .object({
    /** What each trait level means as numbers. */
    levels: z
      .object({
        variety: perLevel(z.number().int().positive()),
        skew: perLevel(z.number().nonnegative()),
        churn: perLevel(z.number().min(0).max(1)),
        growth: perLevel(z.number().min(1)),
        drift: perLevel(z.object({ fraction: z.number().min(0).max(1), everyTurns: z.number().int().min(0) }).strict()),
      })
      .strict(),
    /** Every weak point starts with this weight when an enemy picks one. */
    weakPointBaseWeight: weight,
    /** Traits nudge the choice: certain trait levels make certain weak points likelier. */
    weakPointHints: z
      .object({ variety: traitHints, skew: traitHints, churn: traitHints, growth: traitHints, drift: traitHints })
      .strict(),
  })
  .strict();

export type Traits = z.infer<typeof traitsSchema>;

export function parseTraits(raw: unknown): Traits {
  return traitsSchema.parse(raw);
}

/** Trait tables as validated at load time. Throws if traits.json is malformed. */
export const traits: Traits = parseTraits(traitsJson);

/** The level tables in the shape the engine's stream generator takes. */
export const traitTables: TraitTables = traits.levels;

const WEAK_POINTS: WeakPoint[] = ["presence", "frequency", "count"];
const TRAIT_NAMES = ["variety", "skew", "churn", "growth", "drift"] as const;

/** How likely each weak point is for an enemy with these trait levels: a base weight plus the traits' hints. */
export function weakPointWeights(levels: StreamTraits, source: Traits = traits): Record<WeakPoint, number> {
  const weights: Record<WeakPoint, number> = { presence: 0, frequency: 0, count: 0 };
  for (const point of WEAK_POINTS) {
    weights[point] = source.weakPointBaseWeight;
    for (const trait of TRAIT_NAMES) {
      const level = levels[trait];
      if (level === "low") continue;
      weights[point] += source.weakPointHints[trait][level]?.[point] ?? 0;
    }
  }
  return weights;
}
