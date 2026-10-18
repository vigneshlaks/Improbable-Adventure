import type { LiveSet } from "../enemies/liveSet";
import type { Rng } from "../rng/rng";
import type { Challenge } from "../structures/types";
import { countStrike, frequencyStrike, presenceStrike, rankStrike, type DamageRules, type StrikeResult } from "./damage";

export type WeakPoint = "presence" | "frequency" | "count" | "rank";

export interface ChallengeContext {
  /** How many targets a Presence challenge shows (PRESENCE_TARGETS). */
  presenceTargets: number;
  /** A value the enemy can never emit, used as a never-inserted decoy. */
  drawOutsideValue: (rng: Rng) => number;
  /** The quantile of live values a Rank challenge asks about: the enemy's own. */
  rankQuantile: number;
}

/** What the player commits: a subset of Presence targets by position, or a number (a force or an estimate). */
export type StrikeInput = { targets: number[] } | { value: number };

/** The hidden answer to a challenge, worked out from the live stream. */
export type TrueAnswer =
  | { kind: "presence"; real: boolean[] }
  | { kind: "frequency"; count: number }
  | { kind: "count"; distinct: number }
  /** The armor's quantile, and the smallest live value that reaches it (the best possible strike). */
  | { kind: "rank"; quantile: number; value: number };

const MAX_OUTSIDE_ATTEMPTS = 1000;

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

/**
 * Presence: about half the targets are live values and the rest are decoys. A decoy is either a ghost
 * (a value that was deleted, which structures that ignore deletes still report) or a value never inserted.
 */
function issuePresence(live: LiveSet, rng: Rng, context: ChallengeContext): Challenge {
  const total = context.presenceTargets;
  if (!Number.isInteger(total) || total < 2) throw new RangeError(`A Presence challenge needs at least 2 targets, got ${total}`);

  const wanted = Math.min(total - 1, Math.max(1, Math.round(total / 2) + rng.int(3) - 1));
  const pool = live.liveValues();
  const realCount = Math.min(wanted, pool.length);

  const real: number[] = [];
  for (let i = 0; i < realCount; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
    real.push(pool[i] as number);
  }

  const ghostPool = live.ghosts();
  const decoys = new Set<number>();
  let attempts = 0;
  while (real.length + decoys.size < total) {
    if (ghostPool.length > 0 && rng.float() < 0.5) {
      const index = rng.int(ghostPool.length);
      decoys.add(ghostPool[index] as number);
      ghostPool[index] = ghostPool[ghostPool.length - 1] as number;
      ghostPool.pop();
    } else {
      if (++attempts > MAX_OUTSIDE_ATTEMPTS) throw new RangeError("Could not find enough distinct decoy values");
      decoys.add(context.drawOutsideValue(rng));
    }
  }

  return { kind: "presence", targets: shuffle([...real, ...decoys], rng) };
}

/**
 * The question for one turn, or null when it cannot be asked (a Frequency challenge needs a live value).
 * Uses the generator `rng`; the caller keeps its position in the saved state.
 */
export function issueChallenge(kind: WeakPoint, live: LiveSet, rng: Rng, context: ChallengeContext): Challenge | null {
  switch (kind) {
    case "frequency": {
      const heaviest = live.mode();
      return heaviest ? { kind: "frequency", value: heaviest.value } : null;
    }
    case "count":
      return { kind: "count" };
    case "presence":
      return issuePresence(live, rng, context);
    case "rank": {
      // A heavy value can span more of the ranks than RANK_TOL, so no value would land close to an armor set exactly at the enemy's
      // quantile. The armor is therefore set at the rank of the smallest live value that reaches it: that value is a perfect strike,
      // every lower value is blocked. The quantile named in the challenge is that rank, a little above the enemy's nominal one.
      const best = live.quantileValue(context.rankQuantile);
      return best === null ? null : { kind: "rank", quantile: live.rankOf(best) };
    }
  }
}

/** The real answer to a challenge. Valid until the next burst arrives. */
export function trueAnswer(challenge: Challenge, live: LiveSet): TrueAnswer {
  switch (challenge.kind) {
    case "presence":
      return { kind: "presence", real: challenge.targets.map((target) => live.count(target) > 0) };
    case "frequency":
      return { kind: "frequency", count: live.count(challenge.value) };
    case "count":
      return { kind: "count", distinct: live.distinct };
    case "rank":
      return { kind: "rank", quantile: challenge.quantile, value: live.quantileValue(challenge.quantile) ?? 0 };
  }
}

/** Grades a strike against the live stream. Throws a RangeError if the strike does not fit the challenge. */
export function gradeStrike(challenge: Challenge, live: LiveSet, strike: StrikeInput, rules: DamageRules): StrikeResult {
  const answer = trueAnswer(challenge, live);
  switch (answer.kind) {
    case "presence":
      if (!("targets" in strike)) throw new RangeError("A Presence challenge is answered with a subset of its targets");
      return presenceStrike(rules, answer.real, strike.targets);
    case "frequency":
      if (!("value" in strike)) throw new RangeError("A Frequency challenge is answered with a force");
      return frequencyStrike(rules, answer.count, strike.value);
    case "count":
      if (!("value" in strike)) throw new RangeError("A Count challenge is answered with an estimate");
      return countStrike(rules, answer.distinct, strike.value);
    case "rank":
      if (!("value" in strike)) throw new RangeError("A Rank challenge is answered with a value");
      return rankStrike(rules, answer.quantile, live.rankOf(strike.value), strike.value);
  }
}
