import { Rng } from "../rng/rng";

/** Pearson chi-square statistic for observed counts against expected counts. */
export function chiSquare(observed: number[], expected: number[]): number {
  return observed.reduce((sum, o, i) => sum + (o - (expected[i] ?? 0)) ** 2 / (expected[i] ?? 1), 0);
}

/** 99.9% chi-square quantiles for the degrees of freedom the tests use. A sound sampler stays below these. */
export const CHI2_999: Record<number, number> = { 19: 43.82, 49: 85.35 };

export const rngFor = (label: string) => Rng.fromSeed(`enemies-test/${label}`);
