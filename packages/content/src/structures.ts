import { STRUCTURE_KINDS, type StructureKind } from "@pda/engine";
import { z } from "zod";
import structuresJson from "../structures.json";

const knobSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    min: z.number(),
    max: z.number(),
  })
  .strict()
  .refine((knob) => knob.min <= knob.max, { message: "min must not exceed max" });

const structureSchema = z
  .object({
    name: z.string().min(1),
    /** 1 is the MVP; later phases add structures. */
    phase: z.number().int().min(1).max(3),
    /** Short names accepted by the `deploy` command. */
    aliases: z.array(z.string().min(1)),
    /** The challenge kinds this structure can answer. */
    answers: z.array(z.enum(["presence", "frequency", "count", "rank", "likeness"])).min(1),
    knob: knobSchema.nullable(),
    summary: z.string().min(1),
    help: z.string().min(1),
    flavor: z.string().min(1),
  })
  .strict();

export type StructureInfo = z.infer<typeof structureSchema>;

const structuresSchema = z.object(
  Object.fromEntries(STRUCTURE_KINDS.map((kind) => [kind, structureSchema])) as Record<StructureKind, typeof structureSchema>,
).strict();

export function parseStructures(raw: unknown): Record<StructureKind, StructureInfo> {
  return structuresSchema.parse(raw);
}

/** Descriptions of every structure, as validated at load time. Throws if structures.json is malformed. */
export const structures: Record<StructureKind, StructureInfo> = parseStructures(structuresJson);

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds a structure by its kind, display name or alias, ignoring case and punctuation. */
export function findStructure(name: string): StructureKind | null {
  const wanted = normalize(name);
  for (const kind of STRUCTURE_KINDS) {
    const info = structures[kind];
    if ([kind, info.name, ...info.aliases].some((candidate) => normalize(candidate) === wanted)) return kind;
  }
  return null;
}
