import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { LogLog } from "./logLog";
import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, type StreamParams } from "../enemies/stream";
import { binomialUpper, zForConfidence } from "../stats/stats";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, hashSeed?: number) => new LogLog({ spaceBits, hashSeed }, TEST_CONSTANTS);

describe("LogLog", () => {
  it("uses the largest power-of-two register count with 5 bits per register inside Space", () => {
    expect(make(1280).params).toEqual({ registers: 256, indexBits: 8 });
    expect(make(1279).params).toEqual({ registers: 128, indexBits: 7 });
    expect(make(1280).spaceBits()).toBe(1280);
  });

  it("rejects Space below 16 registers", () => {
    expect(() => make(79)).toThrow(RangeError);
  });

  it("predicts a relative standard error of 1.30 / sqrt(m)", () => {
    expect(make(1280).standardError).toBeCloseTo(1.3 / 16, 12);
  });

  it("ignores repeats and deletes", () => {
    const a = make(1280);
    const b = make(1280);
    for (let v = 0; v < 5000; v++) {
      a.ingest({ op: "insert", value: v });
      b.ingest({ op: "insert", value: v });
      b.ingest({ op: "insert", value: v });
      b.ingest({ op: "delete", value: v });
    }
    expect(b.estimate()).toBe(a.estimate());
  });

  it("answers only count challenges, with a bound that widens with the confidence spread", () => {
    const s = make(1280);
    expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
    expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
    for (let v = 0; v < 5000; v++) s.ingest({ op: "insert", value: v });
    const a = s.query({ kind: "count" });
    expect(a?.low).toBeLessThan(a?.estimate as number);
    expect(a?.high).toBeGreaterThan(a?.estimate as number);
  });

  it("clones independently and merges as a register-wise max", () => {
    const a = make(1280);
    const b = make(1280);
    const rng = trialRng("loglog-merge", 0);
    const values = distinctValues(rng, 6000);
    for (const v of values.slice(0, 3000)) a.ingest({ op: "insert", value: v });
    for (const v of values.slice(3000)) b.ingest({ op: "insert", value: v });
    const union = make(1280);
    for (const v of values) union.ingest({ op: "insert", value: v });
    expect(a.merge(b).estimate()).toBe(union.estimate());
    const copy = a.clone();
    copy.ingest({ op: "insert", value: 123456789 });
    expect(() => a.merge(make(640))).toThrow();
  });

  describe("deletes it cannot see", () => {
    // 64 registers, and streams of thousands of distinct values, where the structure's own error law holds.
    const counter = () => make(320);

    it("counts the inserts and the deletes it ignores", () => {
      const s = counter();
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "delete", value: 1 });
      s.ingest({ op: "delete", value: 1 });
      expect([s.inserts, s.deletes]).toEqual([1, 2]);
    });

    it("keeps the counts through clone, and adds them in a merge", () => {
      const a = counter();
      const b = counter();
      a.ingest({ op: "insert", value: 1 });
      a.ingest({ op: "delete", value: 1 });
      b.ingest({ op: "insert", value: 2 });
      b.ingest({ op: "insert", value: 3 });
      b.ingest({ op: "delete", value: 2 });
      expect([a.clone().inserts, a.clone().deletes]).toEqual([1, 1]);
      const merged = a.merge(b);
      expect([merged.inserts, merged.deletes]).toEqual([3, 2]);
    });

    it("lowers the low bound by the ghosts the deleted share allows, composed from its own ever range", () => {
      const s = counter();
      for (let value = 0; value < 4000; value++) s.ingest({ op: "insert", value });
      for (let value = 0; value < 400; value++) s.ingest({ op: "delete", value }); // a tenth of the units: q = 0.1

      // Rebuild the expected range: the ever range at 97.5 percent, then the ghosts.
      const estimate = s.estimate();
      const sigmaLn = Math.sqrt(Math.log(1 + s.standardError ** 2));
      const centre = (sigmaLn * sigmaLn) / 2;
      const z = zForConfidence(0.975);
      const everLow = estimate * Math.exp(centre - z * sigmaLn);
      const everHigh = estimate * Math.exp(centre + z * sigmaLn);
      const ghosts = Math.min(400, binomialUpper(Math.ceil(everLow), 0.1, 0.975));

      const answer = s.query({ kind: "count" }) as Answer;
      expect(answer.low).toBeCloseTo(Math.max(0, everLow - ghosts), 6);
      expect(answer.high).toBeCloseTo(everHigh, 6);
      // The estimate expects fewer ghosts than the range allows: about 1 unit per value, so about a tenth are ghosts.
      expect(answer.estimate).toBeCloseTo(estimate * (1 - 0.1 * Math.exp(-(Math.max(1, 4000 / estimate) - 1) * 0.9)), 6);
    });

    it("is unchanged until a delete is seen", () => {
      const s = counter();
      for (let value = 0; value < 4000; value++) s.ingest({ op: "insert", value });
      const answer = s.query({ kind: "count" }) as Answer;
      const sigmaLn = Math.sqrt(Math.log(1 + s.standardError ** 2));
      expect(answer.high).toBeCloseTo(s.estimate() * Math.exp(sigmaLn ** 2 / 2 + zForConfidence(0.95) * sigmaLn), 6);
    });

    it("keeps its range honest, and informative, when the enemy deletes values", () => {
      let held = 0;
      let informative = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("loglog-ghosts", t);
        const { events, live } = churnStream(rng, distinctValues(rng, 4000), 6000, 0.25);
        const s = counter();
        for (const e of events) s.ingest(e);
        const answer = s.query({ kind: "count" }) as Answer;
        if (answer.low <= live.distinct && live.distinct <= answer.high) held++;
        if (answer.low > 0) informative++;
      }
      expect(held / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      expect(informative / TRIALS).toBeGreaterThan(0.95);
    });

    // The game's own streams, with bursts big enough that the stream dwarfs the 64 registers.
    const TRIALS_PER_MIX = 120;
    const cases: Array<readonly [string, () => void]> = [];
    for (const churn of [0.1, 0.3]) {
      for (const growth of [1, 1.35]) {
        for (const drift of [{ fraction: 0, everyTurns: 0 }, { fraction: 0.5, everyTurns: 3 }]) {
          const name = `churn ${churn}, growth ${growth}, ${drift.everyTurns ? "drifting" : "fixed"} favorites`;
          cases.push([`keeps its range honest on the enemy stream generator: ${name}`, () => {
            const params: StreamParams = { universe: 16384, churn, growth, drift, skew: 0.8, baseBurst: 1000 };
            let held = 0;
            for (let t = 0; t < TRIALS_PER_MIX; t++) {
              let stream = createStream(`ll-${name}-${t}`);
              const live = new LiveSet();
              const s = counter();
              for (let turn = 0; turn < 4; turn++) {
                const burst = nextBurst(params, stream, live);
                stream = burst.state;
                for (const e of burst.events) s.ingest(e);
              }
              const answer = s.query({ kind: "count" }) as Answer;
              if (answer.low <= live.distinct && live.distinct <= answer.high) held++;
            }
            expect(held / TRIALS_PER_MIX).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS_PER_MIX));
          }]);
        }
      }
    }
    it("keeps its range honest on the enemy stream generator, under every trait mix", () => eachCase(cases, (run) => run()));
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    // Registers m, distinct values n (many times m, where the 1.30 / sqrt(m) law applies).
    const configs = [
      { space: 1280, n: 20000 }, // m = 256, theory 8.1%
      { space: 320, n: 8000 }, // m = 64, theory 16.3%
    ];

    const cases: Array<readonly [string, () => void]> = [];
    for (const { space, n } of configs) {
      cases.push([`m = ${2 ** Math.floor(Math.log2(space / 5))}, n = ${n}: relative error stays within 1.30 / sqrt(m)`, () => {
        let sumSq = 0;
        let sum = 0;
        let covered = 0;
        let theory = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`loglog-${space}`, t);
          const s = make(space);
          for (const v of distinctValues(rng, n)) s.ingest({ op: "insert", value: v });
          theory = s.standardError;
          const a = s.query({ kind: "count" });
          const rel = ((a?.estimate as number) - n) / n;
          sum += rel;
          sumSq += rel * rel;
          if (a && a.low <= n && n <= a.high) covered++;
        }
        const rms = Math.sqrt(sumSq / TRIALS);
        // 10% headroom over theory covers the chance variation in 1,000 trials.
        expect(rms).toBeLessThanOrEqual(theory * 1.1);
        expect(Math.abs(sum / TRIALS)).toBeLessThan(theory * 0.25); // unbiased to within a quarter of one sigma
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      }]);
    }
    it("keeps its relative error within 1.30 / sqrt(m) at every register count", () => eachCase(cases, (run) => run()));
  });
});
