import { STRUCTURE_KINDS } from "@pda/engine";
import { z } from "zod";
import enchantmentsJson from "../enchantments.json";

const kind = z.enum(STRUCTURE_KINDS);

const enchantmentSchema = z
  .object({
    name: z.string().min(1),
    /** 1 is the MVP; later phases add enchantments. */
    phase: z.number().int().min(1).max(3),
    summary: z.string().min(1),
    /** The kinds of structure it can be attached to. */
    valid: z.array(kind).min(1),
    /** For a structure it turns into a named real variant, that variant's name. */
    transforms: z.partialRecord(kind, z.string().min(1)),
    /** Whether it can be offered as a reward. Off until something in the game makes it matter. */
    reward: z.boolean(),
  })
  .strict()
  .refine((enchantment) => new Set(enchantment.valid).size === enchantment.valid.length, { message: "a structure is listed twice" })
  .refine((enchantment) => Object.keys(enchantment.transforms).every((key) => enchantment.valid.includes(key as never)), {
    message: "a transform names a structure the enchantment does not fit",
  });

export type EnchantmentInfo = z.infer<typeof enchantmentSchema>;

export function parseEnchantments(raw: unknown): Record<string, EnchantmentInfo> {
  return z.record(z.string().min(1), enchantmentSchema).parse(raw);
}

/** The enchantments, as validated at load time. Throws if enchantments.json is malformed. */
export const enchantments: Record<string, EnchantmentInfo> = parseEnchantments(enchantmentsJson);

/** The name a structure goes by with this enchantment on it: its variant's name if it transforms, otherwise its own. */
export function variantName(structureName: string, kindOfStructure: (typeof STRUCTURE_KINDS)[number], enchantmentId: string | undefined): string {
  if (enchantmentId === undefined) return structureName;
  return enchantments[enchantmentId]?.transforms[kindOfStructure] ?? structureName;
}
