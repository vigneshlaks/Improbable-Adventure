import { issueChallenge, type LikenessSettings } from "../combat/challenges";
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
  fadingCellBits: 3,
  fadingWindow: 1.5,
  lightCounterBits: 8,
  lightRegisterBits: 3,
  countSketchDefaultDepth: 5,
  topKShare: 0.25,
  cuckooBucketSize: 4,
  cuckooFingerprintBits: 8,
  cuckooMaxKicks: 500,
  kllRankError: 1.6,
  tdigestRankError: 4,
  scalableBloomFirstShare: 0.25,
  scalableBloomTarget: 0.005,
  scalableBloomTightening: 0.5,
  spectralCounterBits: 16,
  dyadicBits: 8,
  dyadicExactMax: 64,
  dyadicExactCounterBits: 16,
  quotientRemainderBits: 8,
  simHashCounterBits: 16,
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

/** The Likeness settings of the shipped balance, with the decoys of a Likeness trait at Medium. */
export const LIKENESS: LikenessSettings = { copies: 6, threshold: 0.6, minSet: 12, maxSet: 1000, realMin: 0.66, realMax: 0.95, decoyMin: 0.35, decoyMax: 0.5 };

/** A Likeness challenge as the game builds it from the live set, or null when it cannot be asked. */
export function likenessChallenge(live: LiveSet, rng: Rng, settings: LikenessSettings = LIKENESS) {
  const challenge = issueChallenge("likeness", live, rng, {
    presenceTargets: 12,
    drawOutsideValue: (r) => 3_000_000_000 + r.int(1_000_000),
    rankQuantile: 0.5,
    likeness: settings,
  });
  if (challenge && challenge.kind !== "likeness") throw new Error("expected a likeness challenge");
  return challenge;
}

/** Presence targets as the game builds them: about half live, the rest ghosts or never-inserted values. */
export function presenceTargets(live: LiveSet, rng: Rng): number[] {
  const challenge = issueChallenge("presence", live, rng, {
    presenceTargets: 12,
    drawOutsideValue: (r) => 3_000_000_000 + r.int(1_000_000),
    rankQuantile: 0.5,
    likeness: LIKENESS,
  });
  if (challenge?.kind !== "presence") throw new Error("expected a presence challenge");
  return challenge.targets;
}
