import { describe, expect, it } from "vitest";
import { KllSketch, kllCapacity } from "./kllSketch";
import { orderStatisticRange, thinningShift } from "./quantiles";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, hashSeed?: number) => new KllSketch({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: KllSketch, values: number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("KllSketch", () => {
  it("costs 32 bits per stored item with k as large as the Space allows; is exact while it holds every unit; never stores more than its capacity however long the stream; counts deletes without acting; answers only Rank; and rejects Space too small to plan for", () => {
    // sized from Space: the capacity of a sketch with k and 24 levels is the most it can hold, and k is the largest that fits
    {
      const s = make(8192);
      const k = s.params.k as number;
      expect(s.params.capacity).toBe(kllCapacity(k, 24));
      expect(kllCapacity(k, 24)).toBeLessThanOrEqual(8192 / 32);
      expect(kllCapacity(k + 1, 24)).toBeGreaterThan(8192 / 32); // one more would not fit
      expect(s.spaceBits()).toBeLessThanOrEqual(8192);
      expect(make(16384).params.k as number).toBeGreaterThan(k);
    }
    // exact while every unit fits in the lowest level
    {
      const s = make(8192);
      feed(s, Array.from({ length: 50 }, (_, i) => (i + 1) * 100));
      expect(s.items).toHaveLength(50);
      expect(s.items.every((item) => item.weight === 1)).toBe(true);
      expect(s.query({ kind: "rank", quantile: 0.5 })).toMatchObject({ estimate: 2500 });
      expect(s.quantile(0.1)).toBe(500);
      expect(s.quantile(1)).toBe(5000);
    }
    // however long the stream, it stays inside its capacity, and its weights add up to about the units inserted
    {
      const s = make(8192);
      const capacity = s.params.capacity as number;
      const rng = trialRng("kll-size", 0);
      let heaviest = 0;
      for (let i = 0; i < 60000; i++) {
        s.ingest({ op: "insert", value: rng.next() });
        if (i % 977 === 0) heaviest = Math.max(heaviest, s.items.length);
      }
      expect(heaviest).toBeLessThanOrEqual(capacity);
      const total = s.items.reduce((sum, item) => sum + item.weight, 0);
      expect(Math.abs(total - 60000) / 60000).toBeLessThan(0.05);
      expect(s.items.some((item) => item.weight > 1)).toBe(true); // it compacted
    }
    // the range is the sketch's own quantiles at the quantile plus and minus its rank error (coefficient over k), widened by the thinning of deletes
    {
      const s = make(8192);
      const k = s.params.k as number;
      feed(s, distinctValues(trialRng("kll-range", 0), 3000));
      const answer = s.query({ kind: "rank", quantile: 0.5 });
      const e = TEST_CONSTANTS.kllRankError / k;
      expect(s.rankError).toBeCloseTo(e, 12);
      expect(answer).toMatchObject({ estimate: s.quantile(0.5), low: s.quantile(0.5 - e), high: s.quantile(0.5 + e) });
      expect((answer?.high as number) - (answer?.low as number)).toBeGreaterThan(0);
      for (let i = 0; i < 1000; i++) s.ingest({ op: "delete", value: i });
      const widened = e + thinningShift(3000 - 1000, 0.5, TEST_CONSTANTS.confidence);
      expect(s.query({ kind: "rank", quantile: 0.5 })).toMatchObject({ low: s.quantile(0.5 - widened), high: s.quantile(0.5 + widened) });
      // near the top the upper end is the largest value kept
      expect(s.query({ kind: "rank", quantile: 0.999 })?.high).toBe(s.items[s.items.length - 1]?.value);
    }
    // deletes are counted and change nothing else
    {
      const s = make(8192);
      feed(s, [5, 6, 7]);
      const before = JSON.stringify(s.snapshot().state.levels);
      s.ingest({ op: "delete", value: 6 });
      expect(s.deletes).toBe(1);
      expect(JSON.stringify(s.snapshot().state.levels)).toBe(before);
    }
    // answers only Rank, and says it has nothing when empty
    {
      const s = make(8192);
      expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "count" })).toBeNull();
      expect(s.query({ kind: "rank", quantile: 0.5 })).toMatchObject({ estimate: 0, high: Number.POSITIVE_INFINITY });
    }
    // Space too small to plan its levels in
    {
      expect(() => make(64)).toThrow(RangeError);
    }
  });

  it("makes the same sketch from the same stream, differently with another seed; snapshots to JSON and back and carries on identically; and clones independently", () => {
    const values = distinctValues(trialRng("kll-det", 0), 5000);
    const a = make(8192, 11);
    const b = make(8192, 11);
    feed(a, values);
    feed(b, values);
    expect(b.snapshot()).toEqual(a.snapshot()); // no generator: a hash of a counter flips the coins
    const other = make(8192, 12);
    feed(other, values);
    expect(other.snapshot()).not.toEqual(a.snapshot());

    const half = make(8192, 11);
    feed(half, values.slice(0, 2500));
    const back = KllSketch.fromSnapshot(JSON.parse(JSON.stringify(half.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(half.snapshot());
    feed(half, values.slice(2500));
    feed(back, values.slice(2500));
    expect(back.snapshot()).toEqual(half.snapshot()); // restored mid-stream, it carries on the same way
    const copy = a.clone();
    feed(copy, [1, 2, 3]);
    expect(copy.snapshot()).not.toEqual(a.snapshot());
    expect(() => KllSketch.fromSnapshot({ ...a.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => KllSketch.fromSnapshot({ ...a.snapshot(), state: { ...a.snapshot().state, levels: [] } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const space = 8192;

    it("has a rank error, measured against the true ranks of the value it names (distance from the quantile to the value's rank interval), whose 95th percentile times k stays within the calibrated coefficient, at every quantile and on flat and skewed streams", () => {
      for (const skewed of [false, true]) {
        const errors: number[] = [];
        let k = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`kll-error-${skewed}`, t);
          const values = distinctValues(rng, 700);
          const { events, live } = churnStream(rng, values, 4000, 0, { skewed });
          const s = make(space);
          for (const e of events) s.ingest(e);
          k = s.params.k as number;
          for (const q of [0.1, 0.5, 0.9, 0.99]) {
            const v = s.quantile(q) as number;
            errors.push(Math.max(0, q - live.rankOf(v), live.rankOf(v - 1) - q));
          }
        }
        errors.sort((a, b) => a - b);
        const p95 = errors[Math.floor(errors.length * 0.95)] as number;
        expect(p95 * k, `skewed ${skewed}`).toBeLessThanOrEqual(TEST_CONSTANTS.kllRankError);
        expect(p95 * k).toBeGreaterThan(0.3); // and it is not trivially small: the coefficient is a real measurement
      }
    });

    it("reports a range that holds the true quantile value at the stated confidence, with no deletes and with Churn, at three quantiles", () => {
      for (const churn of [0, 0.1, 0.3]) {
        for (const quantile of [0.5, 0.9, 0.99]) {
          let covered = 0;
          for (let t = 0; t < TRIALS; t++) {
            const rng = trialRng(`kll-cover-${churn}-${quantile}`, t);
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

    it("is much sharper than a Reservoir of the same Space: its range spans a smaller share of the ranks", () => {
      // The ranges are compared in rank terms on a stream of distinct values, where the rank of a value is its position.
      let kllSpan = 0;
      let reservoirSpan = 0;
      const n = 3000;
      for (let t = 0; t < 40; t++) {
        const rng = trialRng("kll-vs-reservoir", t);
        const values = distinctValues(rng, n);
        const sorted = [...values].sort((a, b) => a - b);
        const rankOf = (v: number) => sorted.filter((x) => x <= v).length / n;
        const s = make(space);
        feed(s, values);
        const a = s.query({ kind: "rank", quantile: 0.5 });
        kllSpan += rankOf(a?.high as number) - rankOf(a?.low as number);
        const sample = [...values].sort(() => rng.float() - 0.5).slice(0, 256).sort((x, y) => x - y); // a uniform sample as many as a Reservoir keeps
        const r = orderStatisticRange(sample, 0.5, TEST_CONSTANTS.confidence);
        reservoirSpan += rankOf(r.high) - rankOf(r.low);
      }
      expect(kllSpan).toBeLessThan(reservoirSpan / 2);
    });
  });
});

