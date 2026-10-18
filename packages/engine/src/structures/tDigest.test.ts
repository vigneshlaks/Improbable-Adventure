import { describe, expect, it } from "vitest";
import { KllSketch } from "./kllSketch";
import { thinningShift } from "./quantiles";
import { TDigest } from "./tDigest";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number) => new TDigest({ spaceBits }, TEST_CONSTANTS);
const feed = (s: TDigest, values: number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("TDigest", () => {
  it("costs 64 bits per slot; is exact while it holds every value; merges into at most its slots however long the stream, with smaller centroids at the ends than in the middle; keeps the smallest and largest value exactly; counts deletes without acting; answers only Rank; and rejects Space for too few slots", () => {
    // sized from Space: 64 bits (a mean and a weight) per slot, compression equal to the slots
    {
      const s = make(8192);
      expect(s.params).toEqual({ slots: 128, compression: 128 });
      expect(s.spaceBits()).toBe(8192);
      expect(make(8200).params.slots).toBe(128);
    }
    // exact while few values: the quantile is the value (the buffer holds them as they are)
    {
      const s = make(8192);
      feed(s, Array.from({ length: 50 }, (_, i) => (i + 1) * 100));
      expect(s.summary.every((c) => c.weight === 1)).toBe(true);
      expect(s.quantile(0.5)).toBeGreaterThanOrEqual(2400);
      expect(s.quantile(0.5)).toBeLessThanOrEqual(2600);
      expect(s.quantile(0)).toBe(100); // below the first centroid's centre: the smallest value, exactly
      expect(s.quantile(1)).toBe(5000);
    }
    // long streams: never more centroids and values than slots, weights add up exactly, ends finer than the middle
    {
      const s = make(8192);
      const rng = trialRng("td-size", 0);
      let most = 0;
      for (let i = 0; i < 50000; i++) {
        s.ingest({ op: "insert", value: rng.next() });
        if (i % 313 === 0) most = Math.max(most, s.summary.length);
      }
      expect(most).toBeLessThanOrEqual(128);
      const summary = s.summary;
      expect(summary.reduce((sum, c) => sum + c.weight, 0)).toBe(50000); // merging never loses a unit
      expect(summary.length).toBeGreaterThan(20);
      expect(summary[0]?.weight).toBeLessThan((summary[Math.floor(summary.length / 2)] as { weight: number }).weight / 4);
      expect(summary[summary.length - 1]?.weight).toBeLessThan((summary[Math.floor(summary.length / 2)] as { weight: number }).weight / 4);
      expect([...summary].map((c) => c.mean)).toEqual([...summary].map((c) => c.mean).sort((a, b) => a - b));
    }
    // the smallest and largest value are kept exactly, however the stream ran
    {
      const s = make(8192);
      feed(s, distinctValues(trialRng("td-ends", 0), 8000));
      const values = distinctValues(trialRng("td-ends", 0), 8000).sort((a, b) => a - b);
      expect(s.quantile(0)).toBe(values[0]);
      expect(s.quantile(1)).toBe(values[values.length - 1]);
    }
    // deletes are counted and change nothing else
    {
      const s = make(8192);
      feed(s, [5, 6, 7]);
      const before = JSON.stringify(s.snapshot().state.means) + JSON.stringify(s.snapshot().state.buffer);
      s.ingest({ op: "delete", value: 6 });
      expect(s.deletes).toBe(1);
      expect(JSON.stringify(s.snapshot().state.means) + JSON.stringify(s.snapshot().state.buffer)).toBe(before);
    }
    // answers only Rank, and says it has nothing when empty
    {
      const s = make(8192);
      expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "count" })).toBeNull();
      expect(s.query({ kind: "rank", quantile: 0.5 })).toMatchObject({ estimate: 0, high: Number.POSITIVE_INFINITY });
      expect(s.quantile(0.5)).toBeNull();
    }
    // Space too small for eight slots
    {
      expect(() => make(64 * 7)).toThrow(RangeError);
    }
  });

  it("gives the range the model says: the quantile at q plus and minus the rank error (coefficient x sqrt(q (1 - q)) over the compression), widened by the thinning of deletes; snapshots to JSON and back and carries on identically; and clones independently", () => {
    const values = distinctValues(trialRng("td-range", 0), 6000);
    const s = make(8192);
    feed(s, values);
    for (const q of [0.01, 0.5, 0.99]) {
      const e = (TEST_CONSTANTS.tdigestRankError * Math.sqrt(q * (1 - q))) / 128;
      expect(s.rankError(q)).toBeCloseTo(e, 12);
      expect(s.query({ kind: "rank", quantile: q })).toMatchObject({ estimate: s.quantile(q), low: s.quantile(Math.max(0, q - e)), high: s.quantile(Math.min(1, q + e)) });
    }
    expect(s.rankError(0.99)).toBeLessThan(s.rankError(0.5) / 4); // sharper at the end
    const before = s.query({ kind: "rank", quantile: 0.5 });
    for (let i = 0; i < 2000; i++) s.ingest({ op: "delete", value: values[i] as number });
    const widened = s.rankError(0.5) + thinningShift(6000 - 2000, 0.5, TEST_CONSTANTS.confidence);
    const after = s.query({ kind: "rank", quantile: 0.5 });
    expect(after).toMatchObject({ low: s.quantile(0.5 - widened), high: s.quantile(0.5 + widened) });
    expect((after?.high as number) - (after?.low as number)).toBeGreaterThan((before?.high as number) - (before?.low as number));

    const half = make(8192);
    feed(half, values.slice(0, 3000));
    const back = TDigest.fromSnapshot(JSON.parse(JSON.stringify(half.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(half.snapshot());
    feed(half, values.slice(3000));
    feed(back, values.slice(3000));
    expect(back.snapshot()).toEqual(half.snapshot());
    const copy = half.clone();
    feed(copy, [1, 2, 3]);
    expect(copy.snapshot()).not.toEqual(half.snapshot());
    expect(() => TDigest.fromSnapshot({ ...half.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => TDigest.fromSnapshot({ ...half.snapshot(), state: { ...half.snapshot().state, weights: [1, 2], means: [1] } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const space = 8192;

    it("has a rank error, against the true ranks (distance from the quantile to the named value's rank interval), whose 95th percentile times compression over sqrt(q (1 - q)) stays within the calibrated coefficient, at five quantiles, on flat and skewed streams", () => {
      for (const skewed of [false, true]) {
        const byQuantile = new Map<number, number[]>();
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`td-error-${skewed}`, t);
          const values = distinctValues(rng, 700);
          const { events, live } = churnStream(rng, values, 4000, 0, { skewed });
          const s = make(space);
          for (const e of events) s.ingest(e);
          for (const q of [0.01, 0.1, 0.5, 0.9, 0.99]) {
            const v = s.quantile(q) as number;
            const error = Math.max(0, q - live.rankOf(v), live.rankOf(v - 1) - q);
            byQuantile.set(q, [...(byQuantile.get(q) ?? []), (error * 128) / Math.sqrt(q * (1 - q))]);
          }
        }
        for (const [q, errors] of byQuantile) {
          errors.sort((a, b) => a - b);
          const p95 = errors[Math.floor(errors.length * 0.95)] as number;
          expect(p95, `skewed ${skewed}, q ${q}`).toBeLessThanOrEqual(TEST_CONSTANTS.tdigestRankError);
        }
      }
    });

    it("reports a range that holds the true quantile value at the stated confidence, with no deletes and with Churn, at four quantiles", () => {
      for (const churn of [0, 0.1, 0.3]) {
        for (const quantile of [0.01, 0.5, 0.9, 0.99]) {
          let covered = 0;
          for (let t = 0; t < TRIALS; t++) {
            const rng = trialRng(`td-cover-${churn}-${quantile}`, t);
            const values = distinctValues(rng, 600);
            const { events, live } = churnStream(rng, values, 4000, churn, { skewed: true });
            const s = make(space);
            for (const e of events) s.ingest(e);
            const truth = live.quantileValue(quantile) as number;
            const a = s.query({ kind: "rank", quantile });
            if (a && a.low <= truth && truth <= a.high) covered++;
          }
          expect(covered / TRIALS, `churn ${churn}, quantile ${quantile}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
        }
      }
    });

    it("is sharper than a KLL sketch of the same Space at the extreme quantiles, which is what it is for, and about as sharp in the middle", () => {
      const span = (kind: "td" | "kll", q: number) => {
        let total = 0;
        for (let t = 0; t < 40; t++) {
          const rng = trialRng("td-vs-kll", t);
          const values = distinctValues(rng, 3000);
          const sorted = [...values].sort((a, b) => a - b);
          const rankOf = (v: number) => sorted.filter((x) => x <= v).length / sorted.length;
          const answer = (kind === "td" ? make(space) : (() => { const k = new KllSketch({ spaceBits: space }, TEST_CONSTANTS); return k; })());
          for (const value of values) answer.ingest({ op: "insert", value });
          const a = answer.query({ kind: "rank", quantile: q });
          total += rankOf(a?.high as number) - rankOf(a?.low as number);
        }
        return total / 40;
      };
      expect(span("td", 0.99)).toBeLessThan(span("kll", 0.99) / 3);
      expect(span("td", 0.01)).toBeLessThan(span("kll", 0.01) / 3);
      expect(span("td", 0.5)).toBeLessThan(span("kll", 0.5) * 1.5); // the same order in the middle
    });
  });
});
