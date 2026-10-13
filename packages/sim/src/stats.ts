import { zForConfidence } from "@pda/engine";

/** The Wilson score interval for a share: `successes` out of `n`, at the given confidence. Stays inside 0 to 1. */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): [number, number] {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`Need 0 <= successes <= n and n >= 1, got ${successes} of ${n}`);
  }
  const z = zForConfidence(confidence);
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
