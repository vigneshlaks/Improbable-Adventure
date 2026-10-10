import { describe, expect, it } from "vitest";
import { Rng } from "./rng";

/** Straight transcription of the canonical sfc32 step, used as an independent reference. */
function referenceSfc32(state: [number, number, number, number], count: number): number[] {
  let [a, b, c, d] = state;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    out.push(t >>> 0);
  }
  return out;
}

describe("Rng", () => {
  it("matches the reference sfc32 from the same state", () => {
    const rng = Rng.fromSeed("known-answer");
    const s = rng.getState();
    const expected = referenceSfc32([s.a, s.b, s.c, s.d], 1000);
    const actual = Array.from({ length: 1000 }, () => rng.next());
    expect(actual).toEqual(expected);
  });

  it("is pinned to a regression vector for seed 'regression'", () => {
    const rng = Rng.fromSeed("regression");
    const first = Array.from({ length: 5 }, () => rng.next());
    // Recorded once from this implementation; a change here means every saved replay changes too.
    expect(first).toEqual(REGRESSION_VECTOR);
  });

  it("replays exactly from the same seed and differs across seeds", () => {
    const a = Rng.fromSeed("alpha");
    const b = Rng.fromSeed("alpha");
    const c = Rng.fromSeed("beta");
    const sa = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(sa);
  });

  it("state round-trips through JSON and resumes the same stream", () => {
    const rng = Rng.fromSeed("roundtrip");
    for (let i = 0; i < 17; i++) rng.next();
    const restored = Rng.fromState(JSON.parse(JSON.stringify(rng.getState())));
    const clone = rng.clone();
    for (let i = 0; i < 100; i++) {
      const v = rng.next();
      expect(restored.next()).toBe(v);
      expect(clone.next()).toBe(v);
    }
  });

  it("sub-streams do not shift when a sibling stream is used", () => {
    const root1 = Rng.fromSeed("run");
    const root2 = Rng.fromSeed("run");
    const enemy1 = root1.split("enemy");
    // Drain unrelated streams on root2 before deriving its enemy stream.
    for (let i = 0; i < 1000; i++) root2.next();
    root2.split("rewards").next();
    const enemy2 = root2.split("enemy");
    for (let i = 0; i < 50; i++) expect(enemy2.next()).toBe(enemy1.next());
    expect(root1.split("rewards").next()).not.toBe(root1.split("enemy").next());
  });

  it("float() stays in [0, 1) and int(n) stays in [0, n)", () => {
    const rng = Rng.fromSeed("ranges");
    for (let i = 0; i < 10000; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const k = rng.int(7);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(7);
    }
    expect(rng.int(1)).toBe(0);
  });

  it("int(n) is uniform (chi-square) and rejects bad bounds", () => {
    const rng = Rng.fromSeed("uniform");
    const n = 10;
    const draws = 100000;
    const counts = new Array<number>(n).fill(0);
    for (let i = 0; i < draws; i++) {
      const k = rng.int(n);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const expected = draws / n;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    // Chi-square test: draws should look uniform at the 99.9% level.
    expect(chi2).toBeLessThan(27.9);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(1.5)).toThrow(RangeError);
  });
});

const REGRESSION_VECTOR: number[] = [1166239816, 1586616731, 134478149, 2704519588, 2948112896];
