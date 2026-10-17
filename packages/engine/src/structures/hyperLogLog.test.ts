import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { HyperLogLog } from "./hyperLogLog";
import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, type StreamParams } from "../enemies/stream";
import type { Answer } from "./types";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, hashSeed?: number) => new HyperLogLog({ spaceBits, hashSeed }, TEST_CONSTANTS);
const insertAll = (s: HyperLogLog, values: number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("HyperLogLog", () => {
  it("uses the largest power-of-two register count with 5 bits per register inside Space; predicts a relative standard error of 1.04 / sqrt(m); answers only count challenges, and says 0 for an empty stream; and 5 more", () => {
    // uses the largest power-of-two register count with 5 bits per register inside Space
    {
      expect(make(1280).params).toEqual({ registers: 256, indexBits: 8 });
      expect(make(1279).params).toEqual({ registers: 128, indexBits: 7 });
      expect(make(1280).spaceBits()).toBe(1280);
      expect(() => make(79)).toThrow(RangeError); // fewer than 16 registers
    }
    // predicts a relative standard error of 1.04 / sqrt(m)
    {
      expect(make(1280).standardError).toBeCloseTo(1.04 / 16, 12);
    }
    // answers only count challenges, and says 0 for an empty stream
    {
      const s = make(1280);
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
      expect(s.query({ kind: "count" })).toMatchObject({ estimate: 0, low: 0 });
    }
    // ignores repeats and deletes when estimating
    {
      const a = make(1280);
      const b = make(1280);
      const values = distinctValues(trialRng("hll-repeat", 0), 3000);
      insertAll(a, values);
      for (const value of values) {
        b.ingest({ op: "insert", value });
        b.ingest({ op: "insert", value });
        b.ingest({ op: "delete", value });
      }
      expect(b.estimate()).toBe(a.estimate());
    }
    // counts empty registers on a small stream (linear counting) and takes the harmonic mean on a large one
    {
      const m = 256;
      const small = make(1280);
      insertAll(small, distinctValues(trialRng("hll-small", 0), 150));
      expect(small.estimate()).toBeCloseTo(m * Math.log(m / small.emptyRegisters), 9);
      expect(small.rawEstimate()).toBeGreaterThan(small.estimate() * 1.2); // the plain harmonic mean is far too high here

      const large = make(1280);
      insertAll(large, distinctValues(trialRng("hll-large", 0), 8000));
      expect(large.estimate()).toBe(large.rawEstimate());
      expect(Math.abs(large.estimate() - 8000) / 8000).toBeLessThan(4 * large.standardError);
    }
    // pins the bias correction: an empty counter's harmonic mean is alpha x m, with the published constants for 16, 32 and 64 registers
    {
      const alphaTimesM = (spaceBits: number) => make(spaceBits).rawEstimate(); // every register empty: alpha x m^2 / m
      expect(alphaTimesM(80)).toBeCloseTo(0.673 * 16, 9);
      expect(alphaTimesM(160)).toBeCloseTo(0.697 * 32, 9);
      expect(alphaTimesM(320)).toBeCloseTo(0.709 * 64, 9);
      expect(alphaTimesM(1280)).toBeCloseTo((0.7213 / (1 + 1.079 / 256)) * 256, 9);
    }
    // keeps its range tight on a small stream, where it counts empty registers and is far more exact than 1.04 / sqrt(m)
    {
      const s = make(5 * 1024);
      insertAll(s, distinctValues(trialRng("hll-tight", 0), 500));
      const a = s.query({ kind: "count" }) as Answer;
      const halfWidth = (a.high - a.low) / 2 / (a.estimate as number);
      expect(halfWidth).toBeLessThan(0.055); // about 1.96 x 2.4%; the plain 1.96 x 3.25% would be 6.4%
      expect(halfWidth).toBeGreaterThan(0.03);
    }
    // clones independently and merges as a register-wise max
    {
      const a = make(1280);
      const b = make(1280);
      const values = distinctValues(trialRng("hll-merge", 0), 6000);
      insertAll(a, values.slice(0, 3000));
      insertAll(b, values.slice(3000));
      const union = make(1280);
      insertAll(union, values);
      expect(a.merge(b).estimate()).toBe(union.estimate());
      const copy = a.clone();
      insertAll(copy, distinctValues(trialRng("hll-copy", 0), 500));
      expect(copy.estimate()).toBeGreaterThan(a.estimate()); // the copy took values the original never saw
      expect(() => a.merge(make(640))).toThrow();
    }
  });

  describe("deletes it cannot see", () => {
    it("counts the inserts and deletes it ignores, through clone and merge; lowers only the low bound, and moves the estimate down by the ghosts to expect; keeps its range honest on the enemy stream generator", () => {
      // counts the inserts and deletes it ignores, through clone and merge
      {
        const s = make(1280);
        s.ingest({ op: "insert", value: 1 });
        s.ingest({ op: "delete", value: 1 });
        s.ingest({ op: "delete", value: 1 });
        expect([s.inserts, s.deletes]).toEqual([1, 2]);
        expect([s.clone().inserts, s.clone().deletes]).toEqual([1, 2]);
        expect([s.merge(s).inserts, s.merge(s).deletes]).toEqual([2, 4]);
      }
      // lowers only the low bound, and moves the estimate down by the ghosts to expect
      {
        const s = make(1280);
        for (let value = 0; value < 800; value++) s.ingest({ op: "insert", value });
        const before = s.query({ kind: "count" }) as Answer;
        for (let value = 0; value < 200; value++) s.ingest({ op: "delete", value }); // a quarter of the units, each value held one
        const after = s.query({ kind: "count" }) as Answer;
        expect(after.low).toBeLessThan(before.low);
        // 800 inserts over about `ever` values, a quarter deleted: a value is a ghost with chance q * exp(-(m - 1)(1 - q)).
        const ever = before.estimate as number;
        expect(after.estimate).toBeCloseTo(ever * (1 - 0.25 * Math.exp(-(800 / ever - 1) * 0.75)), 6);
        expect(after.estimate).toBeLessThan(ever);
        expect(after.estimate).toBeGreaterThanOrEqual(after.low);
      }
      // keeps its range honest on the enemy stream generator
      {
        const cases: Array<readonly [string, () => void]> = [];
        for (const churn of [0.1, 0.3]) {
          for (const growth of [1, 1.35]) {
            cases.push([`churn ${churn}, growth ${growth}`, () => {
              const params: StreamParams = { universe: 16384, churn, growth, drift: { fraction: 0.25, everyTurns: 4 }, skew: 0.8, baseBurst: 200 };
              const runs = 120;
              let held = 0;
              for (let t = 0; t < runs; t++) {
                let stream = createStream(`hll-gen-${churn}-${growth}-${t}`);
                const live = new LiveSet();
                const s = make(640); // 128 registers: the stream has more distinct values than that
                for (let turn = 0; turn < 4; turn++) {
                  const burst = nextBurst(params, stream, live);
                  stream = burst.state;
                  for (const event of burst.events) s.ingest(event);
                }
                const answer = s.query({ kind: "count" }) as Answer;
                if (answer.low <= live.distinct && live.distinct <= answer.high) held++;
              }
              expect(held / runs).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, runs));
            }]);
          }
        }
        eachCase(cases.map(([name, run]) => [name, run] as const), (run) => run());
      }
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    // 1,024 registers, so the spec's standard error is 1.04 / 32 = 3.25%. The estimator switches from linear counting to
    // the harmonic mean around 2.8 m. Near that switch both estimators are about 10 percent noisier than the theory, so
    // the allowance there is 15 percent, and 10 percent elsewhere.
    const m = 1024;
    const space = 5 * m;
    const points = [
      { n: 500, factor: 1.1 }, // linear counting
      { n: 1500, factor: 1.1 },
      { n: 2000, factor: 1.15 }, // around the switch
      { n: 2900, factor: 1.15 },
      { n: 3500, factor: 1.15 },
      { n: 6000, factor: 1.1 }, // harmonic mean
      { n: 12000, factor: 1.1 },
    ];

    it("keeps its relative error within 1.04 / sqrt(m) at every stream size, and its range honest", () => {
      eachCase(points.map((p) => [`m = ${m}, n = ${p.n}`, p] as const), ({ n, factor }) => {
        let sumSq = 0;
        let sum = 0;
        let covered = 0;
        let theory = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`hll-${n}`, t);
          const s = make(space);
          insertAll(s, distinctValues(rng, n));
          theory = s.standardError;
          const a = s.query({ kind: "count" }) as Answer;
          const rel = ((a.estimate as number) - n) / n;
          sum += rel;
          sumSq += rel * rel;
          if (a.low <= n && n <= a.high) covered++;
        }
        expect(Math.sqrt(sumSq / TRIALS)).toBeLessThanOrEqual(theory * factor);
        expect(Math.abs(sum / TRIALS)).toBeLessThan(theory * 0.5); // the linear-counting switch leaves a little bias; nothing more
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      });
    });
  });
});
