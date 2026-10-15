import { z } from "zod";
import upgradesJson from "../upgrades.json";

const effectSchema = z
  .object({
    space: z.number().int().positive().optional(),
    slots: z.number().int().positive().optional(),
    maxCertainty: z.number().int().positive().optional(),
    recovery: z.number().int().positive().optional(),
    damagePercent: z.number().positive().optional(),
  })
  .strict()
  .refine((effect) => Object.keys(effect).length > 0, { message: "an upgrade must change something" });

const upgradeSchema = z.object({ name: z.string().min(1), summary: z.string().min(1), effect: effectSchema }).strict();

export const upgradesSchema = z.record(z.string().min(1), upgradeSchema);

export type UpgradeInfo = z.infer<typeof upgradeSchema>;

export function parseUpgrades(raw: unknown): Record<string, UpgradeInfo> {
  return upgradesSchema.parse(raw);
}

/** The upgrades a run can offer, as validated at load time. Throws if upgrades.json is malformed. */
export const upgrades: Record<string, UpgradeInfo> = parseUpgrades(upgradesJson);
