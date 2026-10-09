import { describe, expect, it } from "vitest";
import { LogLog } from "./logLog";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

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

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    // Registers m, distinct values n (many times m, where the 1.30 / sqrt(m) law applies).
    const configs = [
      { space: 1280, n: 20000 }, // m = 256, theory 8.1%
      { space: 320, n: 8000 }, // m = 64, theory 16.3%
    ];

    for (const { space, n } of configs) {
      it(`m = ${2 ** Math.floor(Math.log2(space / 5))}, n = ${n}: relative error stays within 1.30 / sqrt(m)`, () => {
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
        // Sampling error of an RMS over 1,000 trials is about 2.2%; 10% headroom is more than four standard errors.
        expect(rms).toBeLessThanOrEqual(theory * 1.1);
        expect(Math.abs(sum / TRIALS)).toBeLessThan(theory * 0.25); // unbiased to within a quarter of one sigma
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      });
    }
  });
});
