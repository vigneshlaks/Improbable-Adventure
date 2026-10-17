import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { CountMinSketch } from "./countMinSketch";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

// Count-Min with Conservative Update is a Count-Min Sketch with the Steady enchantment: an insert raises only the counters
// that sit at the smallest value among the value's cells, so shared cells are inflated far less. It still never
// underestimates, but it cannot take deletes back out. Steady costs 10 percent more Space for the same grid.

const STEADY_SPACE = 1 + TEST_CONSTANTS.steadySpaceCost;
const plain = (spaceBits: number, knob = 4, hashSeed = 1) => new CountMinSketch({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);
const steady = (spaceBits: number, knob = 4, hashSeed = 1) => new CountMinSketch({ spaceBits, knob, hashSeed, enchantment: "steady" }, TEST_CONSTANTS);
/** A steady sketch with the same grid as `plain(bits)`: it is given the extra 10 percent. */
const steadyMatching = (bits: number, knob = 4, hashSeed = 1) => steady(Math.ceil(bits * STEADY_SPACE) + 1, knob, hashSeed);

describe("Count-Min Sketch with Conservative Update (Steady)", () => {
  it("builds the same grid from 10 percent more Space, and is charged no more than it was given", () => {
    expect(plain(4096).params).toEqual({ width: 32, depth: 4 });
    expect(steadyMatching(4096).params).toEqual({ width: 32, depth: 4 });
    expect(steady(4096).params).toEqual({ width: 29, depth: 4 }); // 4096 / 1.1 = 3723 bits, 29 columns
    for (const bits of [4096, 5000, 16384]) expect(steady(bits).spaceBits()).toBeLessThanOrEqual(bits);
    // The grid is 32 x 32 x 4 = 4,096 bits and the Steady cost is 10 percent on top.
    expect(steadyMatching(4096).spaceBits()).toBe(Math.ceil(4096 * STEADY_SPACE));
    expect(plain(4096).spaceBits()).toBe(4096);
  });

  it("is a plain Count-Min Sketch when the enchantment is anything else", () => {
    const other = new CountMinSketch({ spaceBits: 4096, knob: 4, hashSeed: 1, enchantment: "seeded" }, TEST_CONSTANTS);
    expect(other.params).toEqual(plain(4096).params);
  });

  it("raises only the smallest counters on an insert", () => {
    const s = steady(5000, 2, 3);
    const p = plain(Math.floor(5000 / STEADY_SPACE), 2, 3);
    // The same two values collide in one row; after inserting both, the conservative sketch keeps the shared counter lower.
    const values = distinctValues(trialRng("cu-unit", 0), 200);
    for (const value of values) {
      s.ingest({ op: "insert", value });
      p.ingest({ op: "insert", value });
    }
    for (const value of values.slice(0, 50)) expect(s.estimate(value)).toBeLessThanOrEqual(p.estimate(value));
    const total = (sketch: CountMinSketch) => values.reduce((sum, value) => sum + sketch.estimate(value), 0);
    expect(total(s)).toBeLessThan(total(p) * 0.9);
  });

  it("counts a value exactly when nothing collides with it, like the plain sketch", () => {
    const s = steady(32 * 64 * 4 * 2);
    for (let i = 0; i < 5; i++) s.ingest({ op: "insert", value: 42 });
    expect(s.estimate(42)).toBe(5);
  });

  describe("deletes it cannot take back", () => {
    it("leaves the counters alone, counts the delete, and still never underestimates the live count", () => {
      const s = steady(8192);
      for (let i = 0; i < 6; i++) s.ingest({ op: "insert", value: 7 });
      const before = s.estimate(7);
      s.ingest({ op: "delete", value: 7 });
      s.ingest({ op: "delete", value: 7 });
      expect(s.estimate(7)).toBe(before); // the ghosts stay in the counters
      expect(s.deletes).toBe(2);
      expect(s.inserts).toBe(6);
      expect(before).toBeGreaterThanOrEqual(4); // the live count is 4
    });

    it("lowers the low bound by the deletes it has seen, and leaves the high bound at the estimate", () => {
      const s = steady(8192);
      for (let value = 0; value < 300; value++) s.ingest({ op: "insert", value });
      for (let i = 0; i < 100; i++) s.ingest({ op: "insert", value: 5 }); // a heavy value, so the low bound is well above 0
      const before = s.query({ kind: "frequency", value: 5 }) as Answer;
      expect(before.low).toBeGreaterThan(20);
      for (let i = 0; i < 10; i++) s.ingest({ op: "delete", value: 100 + i });
      const after = s.query({ kind: "frequency", value: 5 }) as Answer;
      expect(after.estimate).toBe(before.estimate);
      expect(after.high).toBe(before.high);
      expect(after.low).toBeCloseTo(before.low - 10, 9);
    });

    it("keeps its range honest when the enemy deletes values (statistical)", () => {
      let held = 0;
      let total = 0;
      for (let t = 0; t < TRIALS / 4; t++) {
        const rng = trialRng("cu-churn", t);
        const { events, live } = churnStream(rng, distinctValues(rng, 200), 1500, 0.2, { skewed: true });
        const s = steady(8192);
        for (const event of events) s.ingest(event);
        const heaviest = live.mode();
        if (!heaviest) continue;
        const answer = s.query({ kind: "frequency", value: heaviest.value }) as Answer;
        expect(answer.high).toBeGreaterThanOrEqual(heaviest.count); // an upper bound, whatever was deleted
        if (answer.low <= heaviest.count && heaviest.count <= answer.high) held++;
        total++;
      }
      expect(held / total).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, total));
    });
  });

  it("clones independently and survives a merge as an upper bound", () => {
    const a = steady(8192);
    const b = steady(8192);
    a.ingest({ op: "insert", value: 1 });
    a.ingest({ op: "delete", value: 1 });
    b.ingest({ op: "insert", value: 1 });
    const copy = a.clone();
    copy.ingest({ op: "insert", value: 2 });
    expect([a.inserts, a.deletes, copy.inserts, copy.deletes]).toEqual([1, 1, 2, 1]);
    const merged = a.merge(b);
    expect(merged.estimate(1)).toBeGreaterThanOrEqual(2);
    expect([merged.inserts, merged.deletes]).toEqual([2, 1]);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    // Streams with repeated values, so there is a real count to overshoot: 1,500 events over 600 values.
    const stream = (t: number, label: string) => {
      const rng = trialRng(label, t);
      return churnStream(rng, distinctValues(rng, 600), 1500, 0, { skewed: t % 2 === 0 });
    };

    it("never underestimates a value, and overshoots by at most (e / w) x N for at least 1 - e^-d of the values", () => {
      const width = 32;
      let queries = 0;
      let within = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { events, live } = stream(t, "cu-bound");
        const s = steadyMatching(32 * width * 4, 4, t + 1);
        for (const event of events) s.ingest(event);
        const band = (Math.E / width) * 1500;
        for (const value of [live.mode()!.value, events[t % events.length]!.value]) {
          const truth = live.count(value);
          const estimate = s.estimate(value);
          expect(estimate).toBeGreaterThanOrEqual(truth);
          queries++;
          if (estimate - truth <= band) within++;
        }
      }
      expect(within / queries).toBeGreaterThanOrEqual(1 - Math.exp(-4) - 3 * Math.sqrt((Math.exp(-4) * (1 - Math.exp(-4))) / queries));
    });

    it("overshoots a good deal less than the plain sketch on the same stream and the same grid", () => {
      eachCase(
        [32, 64].map((width) => [`width ${width}`, width] as const),
        (width) => {
          let plainOver = 0;
          let steadyOver = 0;
          for (let t = 0; t < TRIALS / 4; t++) {
            const { events, live } = stream(t, `cu-vs-${width}`);
            const p = plain(32 * width * 4, 4, t + 1);
            const s = steadyMatching(32 * width * 4, 4, t + 1);
            for (const event of events) {
              p.ingest(event);
              s.ingest(event);
            }
            const top = live.mode()!;
            expect(s.estimate(top.value)).toBeLessThanOrEqual(p.estimate(top.value)); // never worse, value for value
            plainOver += p.estimate(top.value) - top.count;
            steadyOver += s.estimate(top.value) - top.count;
          }
          expect(steadyOver).toBeLessThan(plainOver * 0.7); // at least 30 percent less overshoot
        },
      );
    });
  });
});
