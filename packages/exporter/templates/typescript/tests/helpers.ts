import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The known answers shared by every language of this toolkit, produced by the reference implementation. */
export const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./vectors.json", import.meta.url)), "utf8"));

/** The i-th value of the fixed test stream: spread across the 32-bit range, the same in every language. */
export const stream = (i: number): number => Math.imul(i + 1, 2654435761) >>> 0;

/** A small seeded random generator (mulberry32), so statistical tests repeat exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uint32 from a seeded generator. */
export const randomU32 = (random: () => number): number => Math.floor(random() * 4294967296);

/** Share of trials that must pass for a bound stated at `confidence`: the confidence minus three standard deviations of chance. */
export const coverageFloor = (confidence: number, trials: number): number => confidence - 3 * Math.sqrt((confidence * (1 - confidence)) / trials);

/** Seeded trials per statistical test. */
export const TRIALS = 200;
