import { describe, expect, it } from "vitest";
import { LinearCounting } from "./linearCounting";
import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, type StreamParams } from "../enemies/stream";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number) => new LinearCounting({ spaceBits }, TEST_CONSTANTS);

describe("LinearCounting", () => {
  it("costs one bit per bitmap cell", () => {
    expect(make(4096).spaceBits()).toBe(4096);
    expect(make(4096).params).toEqual({ m: 4096 });
  });

  it("rejects a bitmap smaller than two bits", () => {
    expect(() => make(1)).toThrow(RangeError);
  });

  it("estimates 0 for an empty stream", () => {
    const a = make(1024).query({ kind: "count" });
    expect(a?.estimate).toBeCloseTo(0, 9);
    expect(a?.low).toBe(0);
  });

  it("applies -m ln(V) to the zero-bit fraction", () => {
    const s = make(1024);
    for (let v = 0; v < 300; v++) s.ingest({ op: "insert", value: v });
    const a = s.query({ kind: "count" });
    expect(a?.estimate).toBeCloseTo(-1024 * Math.log(s.zeroBits / 1024), 9);
  });

  it("ignores repeats and deletes", () => {
    const s = make(1024);
    s.ingest({ op: "insert", value: 5 });
    const zeros = s.zeroBits;
    s.ingest({ op: "insert", value: 5 });
    s.ingest({ op: "delete", value: 5 });
    expect(s.zeroBits).toBe(zeros);
  });

  it("fails visibly when saturated: no zero bits means the estimate is only a floor", () => {
    const s = make(64);
    for (let v = 0; v < 5000; v++) s.ingest({ op: "insert", value: v });
    expect(s.saturated).toBe(true);
    const a = s.query({ kind: "count" });
    expect(a?.high).toBe(Number.POSITIVE_INFINITY);
    expect(a?.estimate).toBeCloseTo(64 * Math.log(64), 9);
    expect(a?.low).toBe(a?.estimate);
  });

  it("answers only count challenges and clones independently", () => {
    const s = make(256);
    expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
    expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
    const c = s.clone();
    c.ingest({ op: "insert", value: 1 });
    expect(s.zeroBits).toBe(256);
    expect(c.zeroBits).toBe(255);
  });

  describe("deletes it cannot see", () => {
    const big = () => make(65536); // roomy, so any shortfall is down to ghosts and not to the bitmap filling

    it("counts the inserts and the deletes it ignores", () => {
      const s = make(4096);
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "delete", value: 1 });
      expect([s.inserts, s.deletes]).toEqual([2, 1]);
      expect(s.query({ kind: "count" })?.high).toBeGreaterThan(0.95); // the deleted value is still counted: a ghost
    });

    it("keeps the counts through clone", () => {
      const s = make(4096);
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "delete", value: 1 });
      expect([s.clone().inserts, s.clone().deletes]).toEqual([1, 1]);
    });

    it("lowers the low bound by the ghosts the deleted share allows, and leaves the high bound alone", () => {
      // 10 distinct values with 4 units each: 40 inserts. Then 20 deletes, so half the units are gone (q = 0.5).
      const s = big();
      for (let value = 1; value <= 10; value++) for (let i = 0; i < 4; i++) s.ingest({ op: "insert", value });
      const before = s.query({ kind: "count" });
      for (let i = 0; i < 20; i++) s.ingest({ op: "delete", value: 1 + (i % 10) });
      const after = s.query({ kind: "count" });

      // Bitmap error is about 0.03 at 97.5 percent, so the ever range is about 9.94 to 10.06. At most 8 of 10
      // values are ghosts at that confidence (a binomial in 1/2), and there were 20 deletes, so 8 decides.
      // The estimate expects fewer ghosts: 4 units per value, half deleted, so a value is a ghost with chance
      // 0.5 * exp(-3 * 0.5), about a ninth. That leaves 10 * (1 - 0.112) = 8.88.
      expect(after?.estimate).toBeCloseTo(10 * (1 - 0.5 * Math.exp(-1.5)), 1);
      expect(after?.low).toBeCloseTo(9.94 - 8, 1);
      expect(after?.high).toBeCloseTo(10.06, 1);
      expect(after?.high as number).toBeGreaterThan(before?.high as number); // the tighter confidence asked of the bitmap
    });

    it("is unchanged until a delete is seen", () => {
      const s = big();
      for (let value = 1; value <= 10; value++) s.ingest({ op: "insert", value });
      const a = s.query({ kind: "count" }) as Answer;
      expect(a.low).toBeCloseTo(10 - 0.04, 1);
      expect(a.high).toBeCloseTo(10 + 0.04, 1);
    });

    it("keeps an infinite upper bound once the bitmap is full", () => {
      const s = make(64);
      for (let value = 0; value < 5000; value++) s.ingest({ op: "insert", value });
      s.ingest({ op: "delete", value: 1 });
      expect(s.query({ kind: "count" })?.high).toBe(Number.POSITIVE_INFINITY);
    });

    it("keeps its range honest, and informative, when the enemy deletes values", () => {
      let held = 0;
      let informative = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("lc-ghosts", t);
        const { events, live } = churnStream(rng, distinctValues(rng, 400), 1200, 0.3);
        const s = make(4096);
        for (const e of events) s.ingest(e);
        const answer = s.query({ kind: "count" }) as Answer;
        if (answer.low <= live.distinct && live.distinct <= answer.high) held++;
        if (answer.low > 0) informative++;
      }
      expect(held / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      expect(informative / TRIALS).toBeGreaterThan(0.95); // a low bound of zero would say nothing
    });

    // The game's own streams, under the trait mixes that hurt most.
    const TRIALS_PER_MIX = 120;
    for (const universe of [256, 16384]) {
      for (const churn of [0.1, 0.3]) {
        for (const growth of [1, 1.35]) {
          for (const drift of [{ fraction: 0, everyTurns: 0 }, { fraction: 0.5, everyTurns: 3 }]) {
            const name = `${universe} values, churn ${churn}, growth ${growth}, ${drift.everyTurns ? "drifting" : "fixed"} favorites`;
            it(`keeps its range honest on the enemy stream generator: ${name}`, () => {
              const params: StreamParams = { universe, churn, growth, drift, skew: 0.8, baseBurst: 200 };
              let held = 0;
              for (let t = 0; t < TRIALS_PER_MIX; t++) {
                let stream = createStream(`lc-${name}-${t}`);
                const live = new LiveSet();
                const s = make(2048);
                for (let turn = 0; turn < 4; turn++) {
                  const burst = nextBurst(params, stream, live);
                  stream = burst.state;
                  for (const e of burst.events) s.ingest(e);
                }
                const answer = s.query({ kind: "count" }) as Answer;
                if (answer.low <= live.distinct && live.distinct <= answer.high) held++;
              }
              expect(held / TRIALS_PER_MIX).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS_PER_MIX));
            });
          }
        }
      }
    }
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const m = 4096;
    // Load factors t = n / m of about 0.24, 0.98 and 1.95.
    for (const n of [1000, 4000, 8000]) {
      it(`n = ${n} (load ${(n / m).toFixed(2)}): error follows sqrt(m (e^t - t - 1)) / n`, () => {
        const t = n / m;
        const theory = Math.sqrt(m * (Math.exp(t) - t - 1)) / n;
        let sumSq = 0;
        let covered = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const rng = trialRng(`linear-${n}`, trial);
          const s = make(m);
          for (const v of distinctValues(rng, n)) s.ingest({ op: "insert", value: v });
          const a = s.query({ kind: "count" });
          const rel = ((a?.estimate as number) - n) / n;
          sumSq += rel * rel;
          if (a && a.low <= n && n <= a.high) covered++;
        }
        expect(Math.sqrt(sumSq / TRIALS)).toBeLessThanOrEqual(theory * 1.1);
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      });
    }
  });
});
