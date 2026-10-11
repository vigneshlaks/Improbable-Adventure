import type { Rng } from "../rng/rng";

// Rejection-inversion sampling for the Zipf distribution (Hormann & Derflinger, 1996).
// It draws a rank in O(1) time with no table, so a 4-million-value universe costs nothing to set up.

function helper1(x: number): number {
  return Math.abs(x) > 1e-8 ? Math.log1p(x) / x : 1 - x * (0.5 - x * (1 / 3 - x * 0.25));
}

function helper2(x: number): number {
  return Math.abs(x) > 1e-8 ? Math.expm1(x) / x : 1 + x * 0.5 * (1 + (x / 3) * (1 + x * 0.25));
}

/**
 * Returns a function that draws a rank in 1..n, where rank k has probability proportional to k^(-s).
 * s = 0 is uniform. Larger s concentrates draws on the lowest ranks.
 */
export function createZipfSampler(n: number, s: number): (rng: Rng) => number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Zipf needs an integer n >= 1, got ${n}`);
  if (!(s >= 0) || !Number.isFinite(s)) throw new RangeError(`Zipf needs a finite exponent >= 0, got ${s}`);
  if (n === 1) return () => 1;
  if (s === 0) return (rng) => rng.int(n) + 1;

  const h = (x: number) => Math.exp(-s * Math.log(x));
  const hIntegral = (x: number) => {
    const logX = Math.log(x);
    return helper2((1 - s) * logX) * logX;
  };
  const hIntegralInverse = (x: number) => {
    const t = Math.max(x * (1 - s), -1);
    return Math.exp(helper1(t) * x);
  };

  const hIntegralX1 = hIntegral(1.5) - 1;
  const hIntegralN = hIntegral(n + 0.5);
  const acceptance = 2 - hIntegralInverse(hIntegral(2.5) - h(2));

  return (rng) => {
    for (;;) {
      const u = hIntegralN + rng.float() * (hIntegralX1 - hIntegralN);
      const x = hIntegralInverse(u);
      const k = Math.min(n, Math.max(1, Math.trunc(x + 0.5)));
      if (k - x <= acceptance || u >= hIntegral(k + 0.5) - h(k)) return k;
    }
  };
}
