import { Rng, type EnemyConfig, type StreamTraits, type WeakPoint } from "@pda/engine";
import { balance, type Balance } from "./balance";
import { traits as defaultTraits, weakPointWeights, type Traits } from "./traits";

export type TierName = keyof Balance["TIERS"];

const TRAIT_NAMES = ["variety", "skew", "churn", "growth", "drift", "likeness"] as const;
const WEAK_POINTS: WeakPoint[] = ["presence", "frequency", "count", "rank", "likeness"];

/** A whole number from `min` to `max`, inclusive. */
function between(rng: Rng, range: { min: number; max: number }): number {
  return range.min + rng.int(range.max - range.min + 1);
}

/**
 * Designs an enemy for a tier: it picks which traits are above Low and how strong, then picks weak points
 * with a bias from those traits. The same seed and tier always give the same enemy.
 */
export function generateEnemy(
  seed: string,
  tier: TierName,
  tuning: Balance = balance,
  traitData: Traits = defaultTraits,
): EnemyConfig {
  const spec = tuning.TIERS[tier];
  if (!spec) throw new RangeError(`Unknown tier: ${String(tier)}`);
  const rng = Rng.fromSeed(`${seed}/enemy-design`);

  const levels: StreamTraits = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low", likeness: "low" };
  const pool = [...TRAIT_NAMES];
  for (let i = between(rng, spec.traitCount); i > 0 && pool.length > 0; i--) {
    const trait = pool.splice(rng.int(pool.length), 1)[0] as (typeof TRAIT_NAMES)[number];
    levels[trait] = rng.float() < spec.highChance ? "high" : "medium";
  }

  // Weak points are drawn in proportion to their weights, without repeats.
  const weights = weakPointWeights(levels, traitData);
  const remaining = WEAK_POINTS.filter((point) => weights[point] > 0); // a weak point with no weight is never drawn
  const weakPoints: WeakPoint[] = [];
  for (let i = Math.min(between(rng, spec.weakPointCount), remaining.length); i > 0; i--) {
    const total = remaining.reduce((sum, point) => sum + weights[point], 0);
    let roll = rng.float() * total;
    let index = remaining.findIndex((point) => (roll -= weights[point]) < 0);
    if (index < 0) index = remaining.length - 1; // guards against rounding at the very end
    weakPoints.push(remaining.splice(index, 1)[0] as WeakPoint);
  }

  // A Rank enemy has an armor at a quantile of its own, drawn from the tiers' list (harder to hit the further up it is).
  const quantiles = tuning.RANK_QUANTILES[tier];
  const rankQuantile = weakPoints.includes("rank") ? (quantiles[rng.int(quantiles.length)] as number) : undefined;
  return { tier, size: spec.size, hp: spec.hp, attack: spec.attack, turnLimit: spec.turnLimit, traits: levels, weakPoints, ...(rankQuantile === undefined ? {} : { rankQuantile }) };
}
