import { describe, expect, it } from "vitest";
import { LinearCounting } from "./linearCounting";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

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
