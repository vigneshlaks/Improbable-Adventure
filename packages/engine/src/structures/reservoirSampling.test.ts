import { describe, expect, it } from "vitest";
import { Rng } from "../rng/rng";
import { ReservoirSampling } from "./reservoirSampling";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, seed = "reservoir-test") =>
  new ReservoirSampling({ spaceBits, rng: Rng.fromSeed(seed) }, TEST_CONSTANTS);

describe("ReservoirSampling", () => {
  it("costs VALUE_BITS per slot", () => {
    const s = make(32 * 10 + 31);
    expect(s.params).toEqual({ slots: 10 });
    expect(s.spaceBits()).toBe(320);
  });

  it("rejects Space below one slot", () => {
    expect(() => make(31)).toThrow(RangeError);
  });

  it("is exact until the reservoir fills", () => {
    const s = make(32 * 10);
    for (const v of [1, 1, 2, 3]) s.ingest({ op: "insert", value: v });
    expect(s.query({ kind: "frequency", value: 1 })).toMatchObject({ estimate: 2, low: 2, high: 2 });
    expect(s.query({ kind: "count" })).toMatchObject({ estimate: 3, low: 3, high: 3 });
    expect([...s.values].sort()).toEqual([1, 1, 2, 3]);
  });

  it("ignores deletes, leaving ghosts in the sample", () => {
    const s = make(32 * 10);
    s.ingest({ op: "insert", value: 9 });
    s.ingest({ op: "delete", value: 9 });
    expect(s.query({ kind: "presence", targets: [9] })?.estimate).toEqual([9]);
  });

  it("never exceeds its slot count", () => {
    const s = make(32 * 8);
    for (let v = 0; v < 1000; v++) s.ingest({ op: "insert", value: v });
    expect(s.values).toHaveLength(8);
    expect(s.insertsSeen).toBe(1000);
  });

  it("is deterministic in its rng and clones independently", () => {
    const a = make(32 * 8, "same");
    const b = make(32 * 8, "same");
    for (let v = 0; v < 500; v++) {
      a.ingest({ op: "insert", value: v });
      b.ingest({ op: "insert", value: v });
    }
    expect([...a.values]).toEqual([...b.values]);
    const copy = a.clone();
    for (let v = 500; v < 800; v++) {
      a.ingest({ op: "insert", value: v });
      copy.ingest({ op: "insert", value: v });
    }
    expect([...copy.values]).toEqual([...a.values]); // clone carries the rng position
    const frozen = [...a.values];
    copy.ingest({ op: "insert", value: 99999 });
    expect([...a.values]).toEqual(frozen);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const slots = 64;
    const space = 32 * slots;

    it("samples uniformly: each stream position is kept with probability slots / N", () => {
      const N = 500;
      const bins = 10;
      const perBin = new Array<number>(bins).fill(0);
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-uniform", t);
        const values = distinctValues(rng, N);
        const position = new Map(values.map((v, i) => [v, i]));
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of values) s.ingest({ op: "insert", value: v });
        for (const v of s.values) {
          const bin = Math.floor(((position.get(v) ?? 0) / N) * bins);
          perBin[bin] = (perBin[bin] ?? 0) + 1;
        }
      }
      const expected = (TRIALS * slots) / bins;
      const chi2 = perBin.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
      // Chi-square test: the sample should look uniform at the 99.9% level.
      expect(chi2).toBeLessThan(27.9);
    });

    it("scales frequency by the sample fraction without bias, and its bounds cover the truth", () => {
      const N = 2000;
      const heavy = 400; // the shielded value occurs 400 times among 2,000 inserts
      let covered = 0;
      let sumEstimate = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-freq", t);
        const [target = 0, ...others] = distinctValues(rng, 1 + (N - heavy));
        const stream = [...new Array<number>(heavy).fill(target), ...others];
        // Fisher-Yates with the trial's own stream.
        for (let i = stream.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
        }
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of stream) s.ingest({ op: "insert", value: v });
        const a = s.query({ kind: "frequency", value: target });
        sumEstimate += a?.estimate as number;
        if (a && a.low <= heavy && heavy <= a.high) covered++;
      }
      expect(Math.abs(sumEstimate / TRIALS / heavy - 1)).toBeLessThan(0.03);
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });

    // Shares near 0% and 100% are where the usual normal approximation breaks down.
    for (const heavy of [1960, 1600, 20, 4]) {
      it(`frequency bounds cover the truth when the target is ${heavy} of 2000 inserts`, () => {
        const N = 2000;
        let covered = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`reservoir-extreme-${heavy}`, t);
          const [target = 0, ...others] = distinctValues(rng, 1 + (N - heavy));
          const stream = [...new Array<number>(heavy).fill(target), ...others];
          for (let i = stream.length - 1; i > 0; i--) {
            const j = rng.int(i + 1);
            [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
          }
          const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
          for (const v of stream) s.ingest({ op: "insert", value: v });
          const a = s.query({ kind: "frequency", value: target });
          if (a && a.low <= heavy && heavy <= a.high) covered++;
        }
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      });
    }

    it("never reports a zero-width frequency bound from a finite sample", () => {
      const s = new ReservoirSampling({ spaceBits: space, rng: Rng.fromSeed("all-hits") }, TEST_CONSTANTS);
      for (let i = 0; i < 2000; i++) s.ingest({ op: "insert", value: 7 }); // every sampled slot holds 7
      const a = s.query({ kind: "frequency", value: 7 });
      expect(a?.estimate).toBe(2000);
      expect(a?.low).toBeLessThan(2000);
      expect(a?.high).toBe(2000);
    });

    it("keeps the true distinct count inside its GEE ratio bounds", () => {
      const distinct = 500;
      const N = 2000;
      let covered = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-distinct", t);
        const values = distinctValues(rng, distinct);
        const stream: number[] = [...values];
        while (stream.length < N) stream.push(values[rng.int(distinct)] ?? 0);
        for (let i = stream.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
        }
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of stream) s.ingest({ op: "insert", value: v });
        const a = s.query({ kind: "count" });
        if (a && a.low <= distinct && distinct <= a.high) covered++;
      }
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });
  });
});
