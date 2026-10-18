import { zForConfidence } from "../stats/stats";

/** The chance that Binomial(n, p) is below `j` (at most j - 1 successes). */
export function binomialBelow(n: number, p: number, j: number): number {
  if (j <= 0) return 0;
  if (j > n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const logRatio = Math.log(p / (1 - p));
  let logPmf = n * Math.log(1 - p);
  let cdf = Math.exp(logPmf);
  for (let k = 0; k < j - 1; k++) {
    logPmf += Math.log((n - k) / (k + 1)) + logRatio;
    cdf += Math.exp(logPmf);
  }
  return Math.min(1, cdf);
}

/** The smallest value of an ascending list with at least `quantile` of the list at or below it. The list must not be empty. */
export function quantileOfSorted(sorted: readonly number[], quantile: number): number {
  const needed = Math.max(1, Math.ceil(quantile * sorted.length - 1e-9));
  return sorted[Math.min(needed, sorted.length) - 1] as number;
}

export interface QuantileRange {
  estimate: number;
  low: number;
  high: number;
}

/**
 * A distribution-free range for the `quantile` of the population a uniform sample (ascending, n values) was drawn from.
 * The number of sample values below the population quantile is Binomial(n, quantile), so the order statistics that bracket
 * it with the stated confidence are found from that distribution alone: no assumption about the values. The upper end is
 * infinite when the sample is too small to bound the quantile from above. `shift` widens the range in quantile terms, on both
 * sides, for a second source of error such as thinning by deletes.
 */
export function orderStatisticRange(sorted: readonly number[], quantile: number, confidence: number, shift = 0): QuantileRange {
  const n = sorted.length;
  const tail = (1 - confidence) / 2;
  const lowQ = Math.max(0, quantile - shift);
  const highQ = Math.min(1, quantile + shift);
  let j = 1; // the largest j (1-based) for which fewer than j sample values below the quantile has chance at most `tail`
  while (j + 1 <= n && binomialBelow(n, lowQ, j + 1) <= tail) j++;
  let k = n; // the smallest k for which at most k - 1 sample values below the quantile has chance at least 1 - tail
  let found = false;
  for (let candidate = 1; candidate <= n; candidate++) {
    if (binomialBelow(n, highQ, candidate) >= 1 - tail) {
      k = candidate;
      found = true;
      break;
    }
  }
  const low = binomialBelow(n, lowQ, 1) <= tail ? (sorted[j - 1] as number) : (sorted[0] as number);
  return { estimate: quantileOfSorted(sorted, quantile), low: Math.min(low, quantileOfSorted(sorted, quantile)), high: found ? (sorted[k - 1] as number) : Number.POSITIVE_INFINITY };
}

/** How far a quantile can move when a random share of units is thinned away, in quantile terms: z standard deviations of a proportion over `units` units. */
export function thinningShift(units: number, quantile: number, confidence: number): number {
  return units <= 0 ? 1 : zForConfidence(confidence) * Math.sqrt((quantile * (1 - quantile)) / units);
}
