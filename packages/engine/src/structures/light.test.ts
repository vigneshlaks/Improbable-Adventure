import { describe, expect, it } from "vitest";
import { CountMinSketch } from "./countMinSketch";
import { HyperLogLog } from "./hyperLogLog";
import { restoreStructure } from "./index";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

// Light narrows the cells: Count-Min counters of 8 bits (they stop at 255) and LogLog or HyperLogLog registers of 3 bits
// (a register stops at rank 7). The same Space buys more of them, so the error is lower, until a cell fills up. A cell that
// has stopped only says "at least this much", so the answer becomes one-sided (its upper bound is infinite).

const plainCms = (spaceBits: number, hashSeed = 1) => new CountMinSketch({ spaceBits, knob: 4, hashSeed }, TEST_CONSTANTS);
const lightCms = (spaceBits: number, hashSeed = 1) => new CountMinSketch({ spaceBits, knob: 4, hashSeed, enchantment: "light" }, TEST_CONSTANTS);

describe("Light Count-Min", () => {
  it("buys four times the columns from the same Space, and its counters stop at 255", () => {
    expect(plainCms(8192).params).toEqual({ width: 64, depth: 4 });
    expect(lightCms(8192).params).toEqual({ width: 256, depth: 4 });
    expect(lightCms(8192).spaceBits()).toBe(8192);
    expect(new CountMinSketch({ spaceBits: 8192, knob: 4, enchantment: "seeded" }, TEST_CONSTANTS).params).toEqual({ width: 64, depth: 4 });

    // Below 255 it counts like the plain sketch; at 255 it stops, says "at least", and cannot be counted back down by deletes.
    const s = lightCms(8192);
    for (let i = 0; i < 200; i++) s.ingest({ op: "insert", value: 42 });
    expect(s.query({ kind: "frequency", value: 42 })).toMatchObject({ estimate: 200, high: 200 });
    for (let i = 0; i < 100; i++) s.ingest({ op: "insert", value: 42 });
    const stopped = s.query({ kind: "frequency", value: 42 }) as Answer;
    expect(stopped.estimate).toBe(255);
    expect(stopped.high).toBe(Number.POSITIVE_INFINITY);
    expect(stopped.low).toBeGreaterThan(200);
    for (let i = 0; i < 50; i++) s.ingest({ op: "delete", value: 42 });
    expect(s.estimate(42)).toBe(255); // a stopped counter is not reliable, so it is left alone
    const other = lightCms(8192);
    for (let i = 0; i < 10; i++) other.ingest({ op: "insert", value: 7 });
    other.ingest({ op: "delete", value: 7 });
    expect(other.estimate(7)).toBe(9); // below the stop it takes deletes back like the plain sketch
    // No counter ever holds more than 255, and merging two sketches stops there too.
    expect(Math.max(...(s.snapshot().state.counters as number[]))).toBe(255);
    const left = lightCms(8192);
    const right = lightCms(8192);
    for (let i = 0; i < 200; i++) {
      left.ingest({ op: "insert", value: 9 });
      right.ingest({ op: "insert", value: 9 });
    }
    const merged = left.merge(right);
    expect(merged.estimate(9)).toBe(255);
    expect(Math.max(...(merged.snapshot().state.counters as number[]))).toBe(255);
  });

  it(`overshoots about a quarter as much as the plain sketch on the same Space, and never underestimates while no counter has stopped (${TRIALS / 4} seeded trials)`, () => {
    let plainOver = 0;
    let lightOver = 0;
    for (let t = 0; t < TRIALS / 4; t++) {
      const rng = trialRng("light-cms", t);
      const { events, live } = churnStream(rng, distinctValues(rng, 600), 1500, 0, { skewed: t % 2 === 0 });
      const p = plainCms(4096, t + 1);
      const l = lightCms(4096, t + 1);
      for (const event of events) {
        p.ingest(event);
        l.ingest(event);
      }
      const top = live.mode()!;
      expect(l.estimate(top.value)).toBeGreaterThanOrEqual(Math.min(255, top.count));
      plainOver += p.estimate(top.value) - top.count;
      lightOver += l.estimate(top.value) - top.count;
    }
    expect(lightOver).toBeLessThan(plainOver * 0.4);
  });
});

describe("Light HyperLogLog", () => {
  // LogLog is not offered Light: it needs about 30 values per register to be accurate, and a 3-bit register stops at about 16.
  const plain = (spaceBits: number, hashSeed?: number) => new HyperLogLog({ spaceBits, hashSeed }, TEST_CONSTANTS);
  const light = (spaceBits: number, hashSeed?: number) => new HyperLogLog({ spaceBits, hashSeed, enchantment: "light" }, TEST_CONSTANTS);

  it("fits three-bit registers, so the same Space buys more of them and the predicted error falls", () => {
    expect(plain(1536).params).toEqual({ registers: 256, indexBits: 8 }); // 1536 / 5 = 307
    expect(light(1536).params).toEqual({ registers: 512, indexBits: 9 }); // 1536 / 3 = 512
    expect(light(1536).spaceBits()).toBe(1536);
    expect(light(1536).standardError).toBeLessThan(plain(1536).standardError * 0.75);
    expect(() => light(40)).toThrow(RangeError); // 16 registers of 3 bits need 48
  });

  it(`is more accurate than the plain counter on the same Space, with a range that holds, while its registers have room (${TRIALS / 2} seeded trials)`, () => {
    const n = 2000; // about 4 values per light register: far from filling a 3-bit register
    let lightSq = 0;
    let plainSq = 0;
    let covered = 0;
    const trials = TRIALS / 2;
    for (let t = 0; t < trials; t++) {
      const rng = trialRng("light-hll", t);
      const l = light(1536, t + 1);
      const p = plain(1536, t + 1);
      for (const value of distinctValues(rng, n)) {
        l.ingest({ op: "insert", value });
        p.ingest({ op: "insert", value });
      }
      const answer = l.query({ kind: "count" }) as Answer;
      lightSq += ((answer.estimate as number) / n - 1) ** 2;
      plainSq += (p.estimate() / n - 1) ** 2;
      if (answer.low <= n && n <= answer.high) covered++;
    }
    expect(Math.sqrt(lightSq / trials)).toBeLessThan(Math.sqrt(plainSq / trials) * 0.9);
    expect(covered / trials).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, trials));
  });

  it("reads low once registers stop, widens its upper bound by exactly what stopping can hide, and has none left when every register is full", () => {
    // Capping can only make the harmonic sum S too large, so the estimate is a floor, and the true sum is at least S - capped x 2^-7:
    // the upper bound is the ordinary one times S / (S - capped x 2^-7).
    const filling = light(192, 3); // 64 registers
    for (const value of distinctValues(trialRng("light-fill", 0), 1500)) filling.ingest({ op: "insert", value });
    const answer = filling.query({ kind: "count" }) as Answer;
    const snapshot = filling.snapshot();
    const registers = snapshot.state.registers as number[];
    const capped = registers.filter((r) => r === 7).length;
    const sum = registers.reduce((total, r) => total + 2 ** -r, 0);
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThan(registers.length);
    const factor = sum / (sum - capped * 2 ** -7);
    expect(factor).toBeGreaterThan(1.05);
    // The same 64 registers in an ordinary 5-bit counter give the ordinary range.
    const { enchantment: _enchantment, ...ordinary } = snapshot;
    void _enchantment;
    const twin = restoreStructure({ ...ordinary, spaceBits: 320 }, TEST_CONSTANTS).query({ kind: "count" }) as Answer;
    expect(answer.estimate).toBeCloseTo(twin.estimate as number, 9);
    expect(answer.low).toBeCloseTo(twin.low, 9);
    expect(answer.high).toBeCloseTo(twin.high * factor, 6);

    // Every register full: nothing is left of the upper bound, and the estimate reads low.
    const full = light(192, 3);
    for (const value of distinctValues(trialRng("light-full", 0), 100000)) full.ingest({ op: "insert", value });
    const stopped = full.query({ kind: "count" }) as Answer;
    expect(stopped.high).toBe(Number.POSITIVE_INFINITY);
    expect(stopped.estimate as number).toBeLessThan(100000);
  });
});
