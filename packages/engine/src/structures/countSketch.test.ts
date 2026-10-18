import { describe, expect, it } from "vitest";
import { medianBandMultiplier } from "../stats/stats";
import { CountSketch } from "./countSketch";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, knob?: number, hashSeed?: number) => new CountSketch({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);

describe("CountSketch", () => {
  it("costs 32 x w x d bits with an odd default depth; is exact when alone and takes deletes back exactly; answers only Frequency, and never below zero; and reports a band that grows with the stream", () => {
    // costs 32 x w x d bits, derives w from Space and depth, and defaults to an odd depth
    {
      const s = make(32 * 100 * 5);
      expect(s.params).toEqual({ width: 100, depth: 5 });
      expect(s.spaceBits()).toBe(32 * 100 * 5);
      expect(make(32 * 64 * 4, 4).params).toEqual({ width: 64, depth: 4 });
      expect(() => make(100, 5)).toThrow(RangeError);
    }
    // exact when alone, and a delete takes exactly one unit back (signed counters make it exact)
    {
      const s = make(32 * 64 * 5);
      for (let i = 0; i < 7; i++) s.ingest({ op: "insert", value: 42 });
      expect(s.estimate(42)).toBe(7);
      s.ingest({ op: "delete", value: 42 });
      s.ingest({ op: "delete", value: 42 });
      expect(s.estimate(42)).toBe(5);
      expect(s.query({ kind: "frequency", value: 42 })).toMatchObject({ estimate: 5 });
    }
    // answers only Frequency, and never reports a negative count
    {
      const s = make(4096);
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "count" })).toBeNull();
      const answer = s.query({ kind: "frequency", value: 9 });
      expect(answer).toMatchObject({ estimate: 0, low: 0 });
      expect(answer?.high).toBeGreaterThanOrEqual(0);
    }
    // the band comes from the counters' sum of squares: zero when empty, wider as the stream gets heavier, narrower with more columns
    {
      const narrow = make(32 * 16 * 5);
      const wide = make(32 * 256 * 5);
      expect(narrow.errorBand).toBe(0);
      for (let v = 1; v <= 600; v++) {
        narrow.ingest({ op: "insert", value: v * 7919 });
        wide.ingest({ op: "insert", value: v * 7919 });
      }
      expect(narrow.errorBand).toBeGreaterThan(wide.errorBand);
      expect(wide.errorBand).toBeGreaterThan(0);
      // The squared norm of n copies of one value is n^2 in every row, and the band is the median multiple times sqrt(norm / width).
      const one = make(32 * 20 * 5);
      for (let i = 0; i < 30; i++) one.ingest({ op: "insert", value: 5 });
      expect(one.squaredNorm).toBe(900);
      expect(one.errorBand).toBeCloseTo(medianBandMultiplier(5, TEST_CONSTANTS.confidence) * Math.sqrt(900 / 20), 9);
      const before = wide.errorBand;
      for (let v = 601; v <= 2400; v++) wide.ingest({ op: "insert", value: v * 7919 });
      expect(wide.errorBand).toBeGreaterThan(before);
    }
  });

  it("snapshots to JSON and back, clones independently, and merges by adding counters", () => {
    const a = make(32 * 32 * 5, 5, 99);
    for (let v = 0; v < 50; v++) a.ingest({ op: "insert", value: v });
    const back = CountSketch.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(a.snapshot());
    const copy = a.clone();
    copy.ingest({ op: "insert", value: 3 });
    expect(a.estimate(3)).not.toBe(copy.estimate(3));
    const b = make(32 * 32 * 5, 5, 99);
    b.ingest({ op: "insert", value: 3 });
    expect(a.merge(b).estimate(3)).toBe(a.estimate(3) + 1);
    expect(() => a.merge(make(32 * 32 * 5, 5, 1))).toThrow();
    expect(() => CountSketch.fromSnapshot({ ...a.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  describe("medianBandMultiplier", () => {
    it("is the smallest multiple of the typical error that a median of d rows stays within with the stated confidence", () => {
      expect(medianBandMultiplier(1, 0.95)).toBeCloseTo(Math.sqrt(20), 1); // one row: Chebyshev, 1 / m^2 <= 5%
      expect(medianBandMultiplier(5, 0.95)).toBeLessThan(medianBandMultiplier(1, 0.95));
      expect(medianBandMultiplier(9, 0.95)).toBeLessThan(medianBandMultiplier(5, 0.95));
      expect(medianBandMultiplier(5, 0.99)).toBeGreaterThan(medianBandMultiplier(5, 0.95));
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const w = 64;
    const d = 5;
    const universe = 300;
    const events = 3000;

    function runTrial(t: number) {
      const rng = trialRng("count-sketch", t);
      const values = distinctValues(rng, universe);
      const s = make(32 * w * d, d);
      const { events: stream, live } = churnStream(rng, values, events, 0.1, { skewed: true });
      for (const e of stream) s.ingest(e);
      return { s, values, live };
    }

    it("is unbiased: the mean error over every value and trial is near zero, where a Count-Min overshoots", () => {
      let sum = 0;
      let total = 0;
      let overshootSum = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { s, values, live } = runTrial(t);
        for (const v of values) {
          const truth = live.count(v);
          sum += s.rawEstimate(v) - truth; // before the clamp at zero, which would add a small upward bias
          overshootSum += Math.abs(s.rawEstimate(v) - truth);
          total++;
        }
      }
      expect(Math.abs(sum / total)).toBeLessThan(0.15);
      expect(overshootSum / total).toBeGreaterThan(0.5); // it is noisy: an unbiased estimate is not an accurate one
    });

    it("reports [low, high] that contain the true count at its stated confidence", () => {
      let covered = 0;
      let total = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { s, values, live } = runTrial(t);
        for (const v of values) {
          const a = s.query({ kind: "frequency", value: v });
          const truth = live.count(v);
          if (a && a.low <= truth && truth <= a.high) covered++;
          total++;
        }
      }
      expect(covered / total).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });
  });
});
