import { buildFightConfig } from "@pda/content";
import { STRUCTURE_KINDS, type FightConfig, type WeakPoint } from "@pda/engine";

/** A Minion with the given weak point and (by default) every structure available. */
export function minion(seed: string, weakPoint: WeakPoint, loadout: FightConfig["loadout"] = [...STRUCTURE_KINDS]): FightConfig {
  const base = buildFightConfig({ seed, tier: "minion", loadout });
  return { ...base, enemy: { ...base.enemy, weakPoints: [weakPoint] } };
}
