import { Rng } from "../rng/rng";
import type { StructureConstants } from "./types";

/** Mirrors content/balance.json for the engine's own tests; the content package checks the two stay in sync. */
export const TEST_CONSTANTS: StructureConstants = {
  valueBits: 32,
  confidence: 0.95,
  cmsDefaultDepth: 4,
  logLogErrorCoefficient: 1.3,
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
