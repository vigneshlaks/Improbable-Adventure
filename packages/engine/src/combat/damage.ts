// The damage rules for each kind of challenge. Pure arithmetic; the numbers come from `balance.json`.

/** The constants the damage rules use, passed in from `balance.json` (the engine cannot import it). */
export interface DamageRules {
  /** Damage of a perfect Frequency or Count strike. */
  base: number;
  /** Damage per real Presence target hit. */
  hitDamage: number;
  /** Certainty lost per decoy hit in Presence. */
  decoyPenalty: number;
  /** Certainty lost when a Frequency strike is blocked. */
  blockPenalty: number;
  /** Certainty lost when a Count estimate is far off. */
  missPenalty: number;
  /** How sharply Frequency damage falls off as the force overshoots the count. */
  overshootExp: number;
  /** Count estimates within this share of the true count still deal some damage. */
  countTol: number;
  /** A Rank strike whose rank is this far above the armor's quantile deals nothing. */
  rankTol: number;
}

export interface PresenceStrike {
  kind: "presence";
  realHits: number;
  decoyHits: number;
  damage: number;
  certaintyLost: number;
  /** How many of the presented targets were real, so the player can see what was missed. */
  realTotal: number;
}

export interface FrequencyStrike {
  kind: "frequency";
  outcome: "hit" | "blocked";
  damage: number;
  certaintyLost: number;
  /** The force the player struck with, and the true count it is judged against. */
  force: number;
  trueCount: number;
}

export interface CountStrike {
  kind: "count";
  outcome: "hit" | "miss";
  /** 1 for an exact estimate, 0 at the edge of the tolerance band, negative beyond it. */
  accuracy: number;
  damage: number;
  certaintyLost: number;
  /** The estimate the player struck with, and the true number of distinct values it is judged against. */
  estimate: number;
  trueDistinct: number;
}

export interface RankStrike {
  kind: "rank";
  outcome: "hit" | "blocked";
  damage: number;
  certaintyLost: number;
  /** The value the player struck with, the share of live units at or below it (its rank), and the armor's quantile. */
  force: number;
  rank: number;
  quantile: number;
}

export type StrikeResult = PresenceStrike | FrequencyStrike | CountStrike | RankStrike;

const DECIMALS = 1e6;

/** Rounds to six decimal places, so tiny floating-point differences cannot change a saved fight. */
export function settle(x: number): number {
  return Math.round(x * DECIMALS) / DECIMALS + 0; // "+ 0" turns -0 into 0
}

/** x raised to a power. Whole exponents use repeated multiplication, which is exact on every engine. */
function power(x: number, exponent: number): number {
  if (Number.isInteger(exponent) && exponent >= 0 && exponent <= 64) {
    let result = 1;
    for (let i = 0; i < exponent; i++) result *= x;
    return result;
  }
  return Math.pow(x, exponent);
}

function assertAmount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
}

/** A force below the true count is blocked. Otherwise damage is BASE x (f / s)^OVERSHOOT_EXP. */
export function frequencyStrike(rules: DamageRules, trueCount: number, force: number): FrequencyStrike {
  assertAmount(force, "force");
  if (force < trueCount) {
    return { kind: "frequency", outcome: "blocked", damage: 0, certaintyLost: rules.blockPenalty, force, trueCount };
  }
  const ratio = force === 0 ? 1 : trueCount / force;
  return { kind: "frequency", outcome: "hit", damage: settle(rules.base * power(ratio, rules.overshootExp)), certaintyLost: 0, force, trueCount };
}

/**
 * A value whose rank is below the armor's quantile is blocked and costs BLOCK_PENALTY. Otherwise damage is
 * BASE x max(0, 1 - (rank - quantile) / RANK_TOL): full damage just at the quantile, none RANK_TOL above it.
 * `rank` is the share of live units at or below the value the player struck with.
 */
export function rankStrike(rules: DamageRules, quantile: number, rank: number, force: number): RankStrike {
  assertAmount(force, "value");
  if (rank < quantile) return { kind: "rank", outcome: "blocked", damage: 0, certaintyLost: rules.blockPenalty, force, rank, quantile };
  const damage = settle(rules.base * Math.max(0, 1 - (rank - quantile) / rules.rankTol));
  return { kind: "rank", outcome: "hit", damage, certaintyLost: 0, force, rank, quantile };
}

/** Damage is BASE x (1 - |E - D| / (COUNT_TOL x D)), floored at zero. A negative accuracy costs MISS_PENALTY. */
export function countStrike(rules: DamageRules, trueDistinct: number, estimate: number): CountStrike {
  assertAmount(estimate, "estimate");
  const tolerance = rules.countTol * trueDistinct;
  const accuracy = tolerance === 0 ? (estimate === trueDistinct ? 1 : -1) : 1 - Math.abs(estimate - trueDistinct) / tolerance;
  if (accuracy < 0) {
    return { kind: "count", outcome: "miss", accuracy: settle(accuracy), damage: 0, certaintyLost: rules.missPenalty, estimate, trueDistinct };
  }
  return { kind: "count", outcome: "hit", accuracy: settle(accuracy), damage: settle(rules.base * accuracy), certaintyLost: 0, estimate, trueDistinct };
}

/**
 * `real[i]` says whether target i is real. `chosen` lists the target positions the player strikes.
 * Each real target deals HIT_DAMAGE and each decoy costs DECOY_PENALTY Certainty.
 */
export function presenceStrike(rules: DamageRules, real: boolean[], chosen: number[]): PresenceStrike {
  const seen = new Set<number>();
  let realHits = 0;
  let decoyHits = 0;
  for (const index of chosen) {
    if (!Number.isInteger(index) || index < 0 || index >= real.length) {
      throw new RangeError(`Target ${index} is not one of the ${real.length} targets`);
    }
    if (seen.has(index)) throw new RangeError(`Target ${index} was chosen twice`);
    seen.add(index);
    if (real[index]) realHits++;
    else decoyHits++;
  }
  return {
    kind: "presence",
    realHits,
    decoyHits,
    damage: settle(rules.hitDamage * realHits),
    certaintyLost: rules.decoyPenalty * decoyHits,
    realTotal: real.filter(Boolean).length,
  };
}
