import { issueChallenge } from "../combat/challenges";
import { LiveSet } from "../enemies/liveSet";
import { Rng } from "../rng/rng";
import type { StreamEvent, StructureConstants } from "./types";

/** Mirrors content/balance.json for the engine's own tests; the content package checks the two stay in sync. */
export const TEST_CONSTANTS: StructureConstants = {
  valueBits: 32,
  confidence: 0.95,
  cmsDefaultDepth: 4,
  logLogErrorCoefficient: 1.3,
  hyperLogLogErrorCoefficient: 1.04,
  hyperLogLogSmallRange: 2.8,
  steadySpaceCost: 0.1,
  superLogLogErrorCoefficient: 1.05,
};

/** Every structure's statistical test runs this many seeded trials. */
export const TRIALS = 1000;

/** n distinct uint32 values, deterministic in the rng. */
export function distinctValues(rng: Rng, n: number): number[] {
  const seen = new Set<number>();
  while (seen.size < n) seen.add(rng.next());
  return [...seen];
}

/** Lowest coverage a sound bound should show over `trials` trials: the stated confidence minus three standard deviations of chance. */
export function coverageFloor(confidence: number, trials: number): number {
  return confidence - 3 * Math.sqrt((confidence * (1 - confidence)) / trials);
}

export function trialRng(label: string, trial: number): Rng {
  return Rng.fromSeed(`${label}-trial-${trial}`);
}

/**
 * A stream in which a share of the events delete a value that is currently live, plus the exact record of what
 * is live afterwards. Deleted values that never come back are the "ghosts" that structures blind to deletes still count.
 */
export function churnStream(
  rng: Rng,
  universe: number[],
  eventCount: number,
  deleteShare: number,
  options: { skewed?: boolean } = {},
): { events: StreamEvent[]; live: LiveSet } {
  const live = new LiveSet();
  const events: StreamEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    if (live.liveTotal > 0 && rng.float() < deleteShare) {
      events.push({ op: "delete", value: live.deleteRandom(rng) as number });
    } else {
      const pick = options.skewed ? rng.float() ** 2 : rng.float(); // squaring favors low indexes: a few heavy values
      const value = universe[Math.floor(universe.length * pick)] as number;
      live.insert(value);
      events.push({ op: "insert", value });
    }
  }
  return { events, live };
}

/** Presence targets as the game builds them: about half live, the rest ghosts or never-inserted values. */
export function presenceTargets(live: LiveSet, rng: Rng): number[] {
  const challenge = issueChallenge("presence", live, rng, {
    presenceTargets: 12,
    drawOutsideValue: (r) => 3_000_000_000 + r.int(1_000_000),
  });
  if (challenge?.kind !== "presence") throw new Error("expected a presence challenge");
  return challenge.targets;
}
