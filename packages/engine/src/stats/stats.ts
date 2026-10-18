// Small statistics helpers that turn a structure's error theory into answer bounds.

/** Error function (Abramowitz & Stegun approximation). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** How many standard deviations wide a range must be for a confidence level (about 1.96 for 95%). */
export function zForConfidence(confidence: number): number {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (erf(mid / Math.SQRT2) < confidence) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The most successes plausible in `n` trials with success chance `p`, at the given confidence. */
export function binomialUpper(n: number, p: number, confidence: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  // Walk up the distribution one step at a time. Probabilities are tracked as logs so that a tiny
  // starting value for large `n` doesn't round to zero and stall the walk.
  const logRatio = Math.log(p / (1 - p));
  let logPmf = n * Math.log(1 - p);
  let cdf = Math.exp(logPmf);
  let q = 0;
  while (cdf < confidence && q < n) {
    logPmf += Math.log((n - q) / (q + 1)) + logRatio;
    cdf += Math.exp(logPmf);
    q++;
  }
  return q;
}

/** Chance of `k` or fewer successes in `n` trials. Summed in log space so large `n` can't underflow. */
function binomialCdf(k: number, n: number, p: number): number {
  const logRatio = Math.log(p / (1 - p));
  let logPmf = n * Math.log(1 - p);
  let total = Math.exp(logPmf);
  for (let i = 0; i < k; i++) {
    logPmf += Math.log((n - i) / (i + 1)) + logRatio;
    total += Math.exp(logPmf);
  }
  return Math.min(1, total);
}

/** Finds the p in [0, 1] where an increasing function first reaches `target` (bisection). */
function invertIncreasing(f: (p: number) => number, target: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Confidence range for a share, given `hits` out of `n` (the Clopper-Pearson interval).
 * Unlike the usual normal approximation, it stays valid when hits is 0 or close to `n`.
 */
export function clopperPearson(hits: number, n: number, confidence: number): { low: number; high: number } {
  if (!(n >= 1) || hits < 0 || hits > n) throw new RangeError(`clopperPearson needs 0 <= hits <= n, got ${hits}/${n}`);
  const tail = (1 - confidence) / 2;
  // Low end: the smallest share for which `hits` or more is still plausible.
  const low = hits === 0 ? 0 : invertIncreasing((p) => 1 - binomialCdf(hits - 1, n, p), tail);
  // High end: the largest share for which `hits` or fewer is still plausible.
  const high = hits === n ? 1 : invertIncreasing((p) => 1 - binomialCdf(hits, n, p), 1 - tail);
  return { low, high };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** The chance that at least `atLeast` of `n` independent trials, each with success chance `p`, succeed. */
export function binomialTail(n: number, p: number, atLeast: number): number {
  if (p >= 1) return atLeast <= n ? 1 : 0;
  let pmf = Math.pow(1 - p, n);
  let tail = atLeast <= 0 ? pmf : 0;
  for (let k = 1; k <= n; k++) {
    pmf *= ((n - k + 1) / k) * (p / (1 - p));
    if (k >= atLeast) tail += pmf;
  }
  return Math.min(1, tail);
}

/**
 * How many "typical errors" wide a range around the median of `rows` independent estimates must be. Each estimate is
 * off by more than `m` typical errors with chance at most 1 / m^2 (Chebyshev); the median is only that far off if at least
 * half of the rows are. The smallest `m` that makes this at most `1 - confidence` is returned.
 */
export function medianBandMultiplier(rows: number, confidence: number): number {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  const needed = Math.ceil(rows / 2);
  let m = 1;
  while (binomialTail(rows, 1 / (m * m), needed) > 1 - confidence) m += 0.01;
  return m;
}
