import { STRUCTURE_KINDS } from "@pda/engine";
import { z } from "zod";
import fusionsJson from "../fusions.json";

const kind = z.enum(STRUCTURE_KINDS);

const fusionSchema = z
  .object({
    name: z.string().min(1),
    /** 1 is the MVP; later phases add recipes. */
    phase: z.number().int().min(1).max(3),
    inputs: z.array(kind).min(2),
    result: kind,
    summary: z.string().min(1),
  })
  .strict()
  .refine((fusion) => new Set(fusion.inputs).size === fusion.inputs.length, { message: "an input is listed twice" })
  .refine((fusion) => !fusion.inputs.includes(fusion.result), { message: "the result is also an input" });

export type FusionInfo = z.infer<typeof fusionSchema>;

export function parseFusions(raw: unknown): Record<string, FusionInfo> {
  return z.record(z.string().min(1), fusionSchema).parse(raw);
}

/** The fusion recipes, as validated at load time. Throws if fusions.json is malformed. */
export const fusions: Record<string, FusionInfo> = parseFusions(fusionsJson);
