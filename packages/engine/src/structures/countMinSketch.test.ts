import { describe, expect, it } from "vitest";
import { CountMinSketch } from "./countMinSketch";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, knob?: number, hashSeed?: number) =>
  new CountMinSketch({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);

describe("CountMinSketch", () => {
  it("costs 32 x w x d bits and derives w from Space and depth; rejects Space that cannot fit one counter per row; counts exactly when there are no collisions in play, and never underestimates; and 4 more", () => {
    // costs 32 x w x d bits and derives w from Space and depth
    {
      const s = make(16384, 4);
      expect(s.params).toEqual({ width: 128, depth: 4 });
      expect(s.spaceBits()).toBe(16384);
      expect(make(1000, 2).params).toEqual({ width: 15, depth: 2 });
      expect(make(16384).params.depth).toBe(4); // default depth
    }
    // rejects Space that cannot fit one counter per row
    {
      expect(() => make(100, 4)).toThrow(RangeError);
    }
    // counts exactly when there are no collisions in play, and never underestimates
    {
      const s = make(32 * 64 * 4, 4);
      for (let i = 0; i < 5; i++) s.ingest({ op: "insert", value: 42 });
      expect(s.estimate(42)).toBeGreaterThanOrEqual(5);
      expect(s.query({ kind: "frequency", value: 42 })).toMatchObject({ estimate: 5, high: 5 });
    }
    // supports deletes and clamps counters at zero
    {
      const s = make(32 * 64 * 4, 4);
      s.ingest({ op: "insert", value: 7 });
      s.ingest({ op: "insert", value: 7 });
      s.ingest({ op: "delete", value: 7 });
      expect(s.estimate(7)).toBe(1);
      s.ingest({ op: "delete", value: 7 });
      s.ingest({ op: "delete", value: 7 }); // already zero: stays zero
      expect(s.estimate(7)).toBe(0);
      expect(s.liveTotal).toBe(0);
    }
    // is one-sided: the high bound equals the estimate and the low bound is the error band below it
    {
      const s = make(32 * 16 * 4, 4);
      for (let v = 0; v < 400; v++) s.ingest({ op: "insert", value: v });
      const a = s.query({ kind: "frequency", value: 3 });
      expect(a?.high).toBe(a?.estimate);
      expect(a?.low).toBeCloseTo(Math.max(0, (a?.estimate as number) - (Math.E / 16) * 400), 9);
      expect(a?.confidence).toBeCloseTo(1 - Math.exp(-4), 12);
    }
    // cannot answer presence or count
    {
      const s = make(4096);
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "count" })).toBeNull();
    }
    // clones independently and merges by adding counters
    {
      const a = make(4096, 4);
      const b = make(4096, 4);
      a.ingest({ op: "insert", value: 1 });
      b.ingest({ op: "insert", value: 1 });
      b.ingest({ op: "insert", value: 2 });
      const copy = a.clone();
      copy.ingest({ op: "insert", value: 1 });
      expect(a.estimate(1)).toBe(1);
      const merged = a.merge(b);
      expect(merged.estimate(1)).toBe(2);
      expect(merged.liveTotal).toBe(3);
      expect(() => a.merge(make(4096, 3))).toThrow();
      expect(() => a.merge(make(4096, 4, 99))).toThrow();
    }
  });

  describe("row independence", () => {
    // Independent rows: two values should collide in every row only 1 in w^d times.
    // Rows derived from double hashing collided together far more often (about 1 in w^2).
    it("collides in all d rows with probability 1 / w^d, not 1 / w^2", () => {
      const w = 7;
      const d = 3;
      const rng = trialRng("cms-rows", 0);
      const pairs = 300000;
      let allRows = 0;
      for (let i = 0; i < pairs; i++) {
        const x = rng.next();
        const y = rng.next();
        if (x === y) continue;
        const s = make(32 * w * d, d);
        s.ingest({ op: "insert", value: x });
        if (s.estimate(y) > 0) allRows++;
      }
      const expected = pairs / w ** d; // about 875
      expect(Math.abs(allRows - expected)).toBeLessThanOrEqual(4 * Math.sqrt(expected));
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const w = 128;
    const d = 4;
    const universe = 200;
    const events = 3000;

    function runTrial(t: number) {
      const rng = trialRng("cms", t);
      const values = distinctValues(rng, universe);
      const s = make(32 * w * d, d);
      const truth = new Map<number, number>();
      for (let i = 0; i < events; i++) {
        // Skewed pick: squaring the uniform sample favors low indexes.
        const v = values[Math.floor(universe * rng.float() ** 2)] ?? 0;
        const live = truth.get(v) ?? 0;
        if (live > 0 && rng.float() < 0.1) {
          s.ingest({ op: "delete", value: v });
          truth.set(v, live - 1);
        } else {
          s.ingest({ op: "insert", value: v });
          truth.set(v, live + 1);
        }
      }
      return { s, values, truth };
    }

    it("never underestimates, and overshoots the (e / w) N band with probability at most e^-d", () => {
      let underestimates = 0;
      let overBand = 0;
      let total = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { s, values, truth } = runTrial(t);
        for (const v of values) {
          const f = truth.get(v) ?? 0;
          const est = s.estimate(v);
          if (est < f) underestimates++;
          if (est - f > s.errorBand) overBand++;
          total++;
        }
      }
      expect(underestimates).toBe(0);
      expect(overBand / total).toBeLessThanOrEqual(Math.exp(-d));
    });

    it("reports [low, high] that contain the true count at its stated confidence", () => {
      let covered = 0;
      let total = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { s, values, truth } = runTrial(t);
        for (const v of values) {
          const f = truth.get(v) ?? 0;
          const a = s.query({ kind: "frequency", value: v });
          if (a && a.low <= f && f <= a.high) covered++;
          total++;
        }
      }
      const stated = 1 - Math.exp(-d);
      expect(covered / total).toBeGreaterThanOrEqual(coverageFloor(stated, TRIALS));
    });
  });
});
