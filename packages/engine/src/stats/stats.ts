// Small deterministic statistics helpers used to turn structure error theory into answer bounds.

/** erf via Abramowitz & Stegun 7.1.26 (absolute error below 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Two-sided z for a confidence level: P(|Z| <= z) = confidence. */
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

/** Smallest q such that P(Binomial(n, p) <= q) >= confidence. */
export function binomialUpper(n: number, p: number, confidence: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  let q = 0;
  while (cdf < confidence && q < n) {
    pmf = (pmf * (n - q) * p) / ((q + 1) * (1 - p));
    cdf += pmf;
    q++;
  }
  return q;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
