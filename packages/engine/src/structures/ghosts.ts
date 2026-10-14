import { binomialUpper, clamp } from "../stats/stats";

// Shared by the structures that estimate how many distinct values were ever inserted and cannot see deletes.

export interface CountRange {
  estimate: number;
  low: number;
  high: number;
}

/**
 * The share of inserted units that have been deleted. A structure can count both, so this is known.
 * With deletes but no inserts seen (a structure deployed late) nothing can be said, so it is 1.
 */
export function deletedShare(inserts: number, deletes: number): number {
  if (deletes === 0) return 0;
  return inserts === 0 ? 1 : Math.min(1, deletes / inserts);
}

/**
 * The share of the values ever inserted that are probably ghosts now.
 *
 * A value is a ghost once all of its units are deleted. Treat each unit as deleted independently with chance q, and
 * the units per value as one plus a Poisson number averaging `inserts / ever - 1`. Then a value is a ghost with
 * chance `q * exp(-(m - 1)(1 - q))`, where m is the average units per value: q when values appear once, and far
 * less when they repeat. A structure can count its inserts and deletes and estimate `ever`, so it can compute this.
 *
 * Never more than q. Measured on the enemy streams it is close where units are spread evenly, and low when a few
 * favorites carry most units and the rest appear once (it then misses ghosts, so the estimate stays a little high).
 */
export function expectedGhostShare(inserts: number, deletes: number, ever: number): number {
  const q = deletedShare(inserts, deletes);
  if (q === 0) return 0;
  const unitsPerValue = ever > 0 ? Math.max(1, inserts / ever) : 1;
  return q * Math.exp(-(unitsPerValue - 1) * (1 - q));
}

/**
 * Turns a range for the values ever inserted into one for the values live now.
 *
 * Live values are the ever-inserted ones minus the ghosts (values whose every unit was deleted). A value is a
 * ghost with chance at most q, the deleted share (one with several units is less likely to vanish), so the ghosts
 * are at most a binomial in q. There can never be more ghosts than deletes. Live cannot exceed ever-inserted, so
 * only the low bound moves. The estimate moves down by the ghosts to expect (see `expectedGhostShare`), and is
 * kept inside the range.
 *
 * `ever(confidence)` gives the structure's own range at a two-sided confidence. The chance of a miss is shared:
 * half to the ghosts, and a quarter to each side of the structure's own range, so the total matches `confidence`.
 */
export function liveCountRange(
  ever: (confidence: number) => CountRange,
  inserts: number,
  deletes: number,
  confidence: number,
): CountRange {
  if (deletes === 0) return ever(confidence);

  const miss = 1 - confidence;
  const range = ever(1 - miss / 2);
  const ghosts = Math.min(deletes, binomialUpper(Math.ceil(range.low), deletedShare(inserts, deletes), 1 - miss / 2));
  const low = Math.max(0, range.low - ghosts);
  const expected = range.estimate * (1 - expectedGhostShare(inserts, deletes, range.estimate));
  return { estimate: clamp(expected, low, range.high), low, high: range.high };
}
