import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { LogLog } from "./logLog";
import type { Answer } from "./types";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

// SuperLogLog is LogLog with the Steady enchantment: it averages only the smallest 70 percent of the registers, throwing
// away the lucky outliers, which cuts the standard error from 1.30 / sqrt(m) to about 1.05 / sqrt(m). Steady costs 10
// percent more Space for the same registers.

const STEADY_SPACE = 1 + TEST_CONSTANTS.steadySpaceCost;
const plain = (spaceBits: number, hashSeed?: number) => new LogLog({ spaceBits, hashSeed }, TEST_CONSTANTS);
const steady = (spaceBits: number, hashSeed?: number) => new LogLog({ spaceBits, hashSeed, enchantment: "steady" }, TEST_CONSTANTS);
/** Steady with the same registers as `plain(bits)`: given the extra 10 percent. */
const steadyMatching = (bits: number, hashSeed?: number) => steady(Math.ceil(bits * STEADY_SPACE) + 1, hashSeed);

describe("SuperLogLog (LogLog with Steady)", () => {
  it("builds the same registers from 10 percent more Space, and fewer from the same Space", () => {
    expect(plain(1280).params).toEqual({ registers: 256, indexBits: 8 });
    expect(steadyMatching(1280).params).toEqual({ registers: 256, indexBits: 8 });
    expect(steady(1280).params).toEqual({ registers: 128, indexBits: 7 }); // 1280 / 1.1 = 1163 bits, 232 registers, 128 as a power of two
    expect(steady(1280).spaceBits()).toBeLessThanOrEqual(1280);
    expect(steadyMatching(1280).spaceBits()).toBe(Math.ceil(1280 * STEADY_SPACE)); // 256 registers x 5 bits, plus the Steady cost
    expect(plain(1280).spaceBits()).toBe(1280);
    expect(() => steady(80)).toThrow(RangeError); // 80 bits is 16 registers, but 10 percent of them are lost to the cost
  });

  it("predicts a relative standard error of 1.05 / sqrt(m), against LogLog's 1.30", () => {
    expect(steadyMatching(1280).standardError).toBeCloseTo(1.05 / 16, 12);
    expect(plain(1280).standardError).toBeCloseTo(1.3 / 16, 12);
  });

  it("is a plain LogLog when the enchantment is anything else", () => {
    const other = new LogLog({ spaceBits: 1280, hashSeed: 5, enchantment: "seeded" }, TEST_CONSTANTS);
    const control = plain(1280, 5);
    for (const value of distinctValues(trialRng("sll-other", 0), 3000)) {
      other.ingest({ op: "insert", value });
      control.ingest({ op: "insert", value });
    }
    expect(other.estimate()).toBe(control.estimate());
  });

  it("discards the largest 30 percent of the registers, so one lucky register no longer moves the estimate much", () => {
    const sample = (counter: LogLog) => {
      for (const value of distinctValues(trialRng("sll-lucky", 0), 20000)) counter.ingest({ op: "insert", value });
      return counter;
    };
    const normal = sample(steadyMatching(1280));
    const withOutlier = sample(steadyMatching(1280));
    const registers = (withOutlier.snapshot().state.registers as number[]).slice();
    registers[0] = 31; // one register claims an impossibly rare pattern
    const tampered = steadyMatching(1280);
    (tampered as unknown as { registers: Uint8Array }).registers = Uint8Array.from(registers);
    expect(Math.abs(tampered.estimate() - normal.estimate()) / normal.estimate()).toBeLessThan(0.02);
    // LogLog averages all registers, so the same register shifts its estimate by 2^(26/256) - 1, about 7 percent.
    const logLogNormal = sample(plain(1280));
    const logLogTampered = plain(1280);
    (logLogTampered as unknown as { registers: Uint8Array }).registers = Uint8Array.from(registers);
    expect(Math.abs(logLogTampered.estimate() - logLogNormal.estimate()) / logLogNormal.estimate()).toBeGreaterThan(0.05);
  });

  it("clones, merges as a register-wise max, and ignores repeats and deletes like LogLog", () => {
    const a = steady(1280, 9);
    const b = steady(1280, 9);
    const values = distinctValues(trialRng("sll-merge", 0), 6000);
    for (const value of values.slice(0, 3000)) a.ingest({ op: "insert", value });
    for (const value of values.slice(3000)) b.ingest({ op: "insert", value });
    const union = steady(1280, 9);
    for (const value of values) union.ingest({ op: "insert", value });
    expect(a.merge(b).estimate()).toBe(union.estimate());
    expect(() => a.merge(plain(640, 9))).not.toThrow(); // the same 128 registers: merging is by registers
    const noisy = steady(1280, 9);
    for (const value of values.slice(0, 3000)) {
      noisy.ingest({ op: "insert", value });
      noisy.ingest({ op: "insert", value });
      noisy.ingest({ op: "delete", value });
    }
    expect(noisy.estimate()).toBe(a.estimate());
  });

  describe("deletes it cannot see", () => {
    it("counts them, and moves the estimate down and the low bound further down, as LogLog does", () => {
      const s = steady(2560);
      for (let value = 0; value < 4000; value++) s.ingest({ op: "insert", value });
      const before = s.query({ kind: "count" }) as Answer;
      for (let value = 0; value < 1000; value++) s.ingest({ op: "delete", value });
      const after = s.query({ kind: "count" }) as Answer;
      expect([s.inserts, s.deletes]).toEqual([4000, 1000]);
      expect(after.low).toBeLessThan(before.low);
      expect(after.estimate).toBeLessThan(before.estimate as number);
      expect(after.high).toBeGreaterThanOrEqual(before.high); // its own range is taken at 97.5 percent once a delete has been seen
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    // Registers m, distinct values n (many times m, where the error law applies). Space is chosen so Steady keeps the registers.
    const configs = [
      { space: 1280, n: 20000 }, // m = 256, theory 6.6%
      { space: 320, n: 8000 }, // m = 64, theory 13.1%
    ];

    it("keeps its relative error within 1.05 / sqrt(m) of theory, unbiased, with a range that covers the truth", () => {
      eachCase(configs.map((c) => [`m = ${2 ** Math.floor(Math.log2(c.space / 5))}, n = ${c.n}`, c] as const), ({ space, n }) => {
        let sumSq = 0;
        let sum = 0;
        let covered = 0;
        let theory = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`sll-${space}`, t);
          const s = steadyMatching(space);
          for (const v of distinctValues(rng, n)) s.ingest({ op: "insert", value: v });
          theory = s.standardError;
          const a = s.query({ kind: "count" }) as Answer;
          const rel = ((a.estimate as number) - n) / n;
          sum += rel;
          sumSq += rel * rel;
          if (a.low <= n && n <= a.high) covered++;
        }
        expect(Math.sqrt(sumSq / TRIALS)).toBeLessThanOrEqual(theory * 1.1);
        expect(Math.abs(sum / TRIALS)).toBeLessThan(theory * 0.25);
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      });
    });

    it("is more accurate than LogLog with the same registers on the same streams", () => {
      const space = 1280;
      const n = 20000;
      let steadySq = 0;
      let plainSq = 0;
      for (let t = 0; t < TRIALS / 2; t++) {
        const rng = trialRng("sll-vs", t);
        const s = steadyMatching(space, t + 1);
        const p = plain(space, t + 1);
        for (const v of distinctValues(rng, n)) {
          s.ingest({ op: "insert", value: v });
          p.ingest({ op: "insert", value: v });
        }
        steadySq += (s.estimate() / n - 1) ** 2;
        plainSq += (p.estimate() / n - 1) ** 2;
      }
      expect(Math.sqrt(steadySq / (TRIALS / 2))).toBeLessThan(Math.sqrt(plainSq / (TRIALS / 2)) * 0.92);
    });
  });
});
