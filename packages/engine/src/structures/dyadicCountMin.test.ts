import { describe, expect, it } from "vitest";
import { DyadicCountMin } from "./dyadicCountMin";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Challenge } from "./types";

const make = (spaceBits: number, knob?: number) => new DyadicCountMin({ spaceBits, knob }, TEST_CONSTANTS);
/** A value in bucket `b` (the top 8 bits), at offset `o` within it. */
const inBucket = (b: number, o = 0) => ((b << 24) | o) >>> 0;

describe("DyadicCountMin", () => {
  it("keeps the levels with few intervals exactly and sketches the rest within the Space; finds the bucket of a quantile and answers with its edges; is exact when the sketches have room; takes deletes back exactly; answers only Rank; and snapshots, clones", () => {
    // 256 buckets: levels 2 to 7 (64 intervals or fewer) are exact counters, levels 0 and 1 are sketches
    {
      const s = make(8192);
      expect(s.params).toMatchObject({ buckets: 256, exactLevels: 6, sketchLevels: 2, depth: 3 });
      expect(s.spaceBits()).toBeLessThanOrEqual(8192);
      expect(s.spaceBits()).toBeGreaterThan(8192 * 0.9);
      expect(make(32768).params.width as number).toBeGreaterThan(s.params.width as number);
      expect(make(8192, 5).params.depth).toBe(5);
      expect(() => make(512)).toThrow(RangeError);
      expect(s.bucketWidth).toBe(2 ** 24);
    }
    // with room for the sketches the counts are exact: ten buckets, one value each; the median is in the fifth bucket and the answer says which values it could be
    {
      const s = make(262144);
      for (let b = 0; b < 10; b++) s.ingest({ op: "insert", value: inBucket(b * 3, 77) });
      const median = s.query({ kind: "rank", quantile: 0.5 });
      expect(median).toMatchObject({ estimate: inBucket(12) + 2 ** 24 - 1, low: inBucket(12) }); // bucket 12 holds the fifth of ten units
      expect(median?.high).toBe(inBucket(15) + 2 ** 24 - 1); // the sketches' expected overshoot is a fraction of a unit: it reaches the next occupied bucket, no further
      expect(s.query({ kind: "rank", quantile: 0.1 })).toMatchObject({ low: inBucket(0) });
      expect(s.query({ kind: "rank", quantile: 1 })).toMatchObject({ low: inBucket(27) });
      expect(s.liveTotal).toBe(10);
    }
    // the band is the sum of the two sketch levels' bands, and the confidence the product of theirs
    {
      const s = make(8192);
      for (const value of distinctValues(trialRng("dyadic-band", 0), 400)) s.ingest({ op: "insert", value });
      const width = s.params.width as number;
      expect(s.errorBand).toBeCloseTo(2 * ((Math.E / width) * 400), 9);
      expect(s.bandConfidence).toBeCloseTo((1 - Math.exp(-3)) ** 2, 12);
    }
    // a high quantile cannot be bounded from above when the band reaches past the total; a low one can
    {
      const s = make(8192);
      for (const value of distinctValues(trialRng("dyadic-high", 0), 600)) s.ingest({ op: "insert", value });
      expect(s.errorBand).toBeGreaterThan(0.01 * 600);
      expect(s.query({ kind: "rank", quantile: 0.99 })?.high).toBe(Number.POSITIVE_INFINITY);
      expect(Number.isFinite(s.query({ kind: "rank", quantile: 0.3 })?.high as number)).toBe(true);
    }
    // nothing yet: no upper end
    {
      expect(make(8192).query({ kind: "rank", quantile: 0.5 })).toMatchObject({ estimate: 0, low: 0, high: Number.POSITIVE_INFINITY });
    }
    // deletes take the counts back exactly: put units in and take them out and the structure is as new
    {
      const s = make(8192);
      const empty = JSON.stringify(s.snapshot());
      const values = distinctValues(trialRng("dyadic-del", 0), 80);
      for (const value of values) s.ingest({ op: "insert", value });
      for (const value of values) s.ingest({ op: "delete", value });
      expect(JSON.stringify(s.snapshot())).toBe(empty);
      s.ingest({ op: "delete", value: 5 }); // nothing live: ignored
      expect(s.liveTotal).toBe(0);
    }
    // only Rank
    {
      for (const challenge of [{ kind: "presence", targets: [1] }, { kind: "frequency", value: 1 }, { kind: "count" }] as Challenge[]) expect(make(8192).query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores; a clone is independent; bad snapshots are refused
    {
      const s = make(8192);
      for (const value of distinctValues(trialRng("dyadic-snap", 0), 200)) s.ingest({ op: "insert", value });
      const back = DyadicCountMin.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      expect(back.query({ kind: "rank", quantile: 0.9 })).toEqual(s.query({ kind: "rank", quantile: 0.9 }));
      const copy = s.clone();
      copy.ingest({ op: "insert", value: 42 });
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => DyadicCountMin.fromSnapshot({ ...s.snapshot(), kind: "countMinSketch" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => DyadicCountMin.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, exact: [] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 150;

    it("holds the true quantile value between its low and high at the stated confidence, with no deletes and with Churn, at three quantiles and two sizes; and the range narrows as the Space grows", () => {
      const spans: Record<number, number> = {};
      for (const space of [8192, 32768]) {
        let span = 0;
        let spanCount = 0;
        for (const churn of [0, 0.1, 0.3]) {
          for (const quantile of [0.5, 0.9, 0.99]) {
            let covered = 0;
            let floor = 1;
            for (let t = 0; t < TRIALS; t++) {
              const rng = trialRng(`dyadic-${space}-${churn}-${quantile}`, t);
              const values = distinctValues(rng, 600);
              const { events, live } = churnStream(rng, values, 3000, churn, { skewed: true });
              const s = make(space);
              for (const e of events) s.ingest(e);
              const truth = live.quantileValue(quantile) as number;
              const answer = s.query({ kind: "rank", quantile });
              floor = Math.min(floor, s.bandConfidence);
              if (answer && answer.low <= truth && truth <= answer.high) covered++;
              if (answer && Number.isFinite(answer.high)) {
                span += (answer.high - answer.low) / 2 ** 32;
                spanCount++;
              }
            }
            expect(covered / TRIALS, `space ${space}, churn ${churn}, quantile ${quantile}`).toBeGreaterThanOrEqual(coverageFloor(floor, TRIALS));
          }
        }
        spans[space] = span / spanCount;
      }
      expect(spans[32768]).toBeLessThan((spans[8192] as number) * 0.6);
    });

    it("never finds a bucket above the true one at the estimate: the overcount can only make it too low (so the upper end is the safe end)", () => {
      for (const [quantile, space] of [[0.5, 8192], [0.9, 8192], [0.5, 2800], [0.9, 2800], [1, 2800]] as const) {
        for (let t = 0; t < 100; t++) {
          const rng = trialRng(`dyadic-side-${quantile}-${space}`, t);
          const values = distinctValues(rng, 600);
          const { events, live } = churnStream(rng, values, 3000, 0, { skewed: true });
          const s = make(space); // 1,700 bits is nearly the least: the sketches are 4 wide and collide all the time
          for (const e of events) s.ingest(e);
          const truth = live.quantileValue(quantile) as number;
          const answer = s.query({ kind: "rank", quantile });
          expect((answer?.low as number) >>> 24).toBeLessThanOrEqual(truth >>> 24);
        }
      }
    });
  });
});
