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
 * Turns a range for the values ever inserted into one for the values live now.
 *
 * Live values are the ever-inserted ones minus the ghosts (values whose every unit was deleted). A value is a
 * ghost with chance at most q, the deleted share (one with several units is less likely to vanish), so the ghosts
 * are at most a binomial in q. There can never be more ghosts than deletes. Live cannot exceed ever-inserted, so
 * only the low bound moves.
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
  return { estimate: clamp(range.estimate, low, range.high), low, high: range.high };
}
