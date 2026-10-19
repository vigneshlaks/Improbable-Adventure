import { buildFightConfig } from "@pda/content";
import { STRUCTURE_KINDS, type FightConfig, type StreamTraits, type WeakPoint } from "@pda/engine";

/** A Minion with the given weak point and (by default) every structure available. */
export function minion(seed: string, weakPoint: WeakPoint, loadout: FightConfig["loadout"] = [...STRUCTURE_KINDS]): FightConfig {
  const base = buildFightConfig({ seed, tier: "minion", loadout });
  return { ...base, enemy: { ...base.enemy, weakPoints: [weakPoint] } };
}

/** A Minion with chosen stream traits (the rest Low) and a chosen weak point. */
export function minionWith(seed: string, weakPoint: WeakPoint, traits: Partial<StreamTraits>, loadout: FightConfig["loadout"] = [...STRUCTURE_KINDS]): FightConfig {
  const config = minion(seed, weakPoint, loadout);
  return { ...config, enemy: { ...config.enemy, traits: { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low", likeness: "low", ...traits } } };
}
