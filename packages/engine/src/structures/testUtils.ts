import { Rng } from "../rng/rng";
import type { StructureConstants } from "./types";

/** Mirrors content/balance.json for the engine's own tests; the content package checks the two stay in sync. */
export const TEST_CONSTANTS: StructureConstants = { valueBits: 32, confidence: 0.95 };

/** Every structure's statistical test runs this many seeded trials. */
export const TRIALS = 1000;

/** n distinct uint32 values, deterministic in the rng. */
export function distinctValues(rng: Rng, n: number): number[] {
  const seen = new Set<number>();
  while (seen.size < n) seen.add(rng.next());
  return [...seen];
}

/**
 * Lowest acceptable coverage for a nominal confidence over `trials` independent trials:
 * the nominal level minus three binomial standard deviations. A sound bound passes this essentially always.
 */
export function coverageFloor(confidence: number, trials: number): number {
  return confidence - 3 * Math.sqrt((confidence * (1 - confidence)) / trials);
}

export function trialRng(label: string, trial: number): Rng {
  return Rng.fromSeed(`${label}-trial-${trial}`);
}
