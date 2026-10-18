import { describe, expect, it } from "vitest";
import { CountMinSketch } from "./countMinSketch";
import { TopKTracker } from "./topKTracker";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, knob?: number) => new TopKTracker({ spaceBits, knob }, TEST_CONSTANTS);

describe("TopKTracker", () => {
  it("splits its Space between a Count-Min grid and a candidate list, never over; is exact for a lone value; keeps the heaviest values on the list and frees a place when a value is deleted away; answers only Frequency; and rejects Space too small for a list", () => {
    // splits its Space: a quarter for the list at 96 bits an entry, the rest for the grid
    {
      const t = make(8192, 4);
      expect(t.params).toEqual({ width: 48, depth: 4, candidates: 21 });
      expect(t.spaceBits()).toBeLessThanOrEqual(8192);
      expect(t.spaceBits()).toBeGreaterThan(8192 - 32 * 4 - 96); // wastes less than one column and one entry
    }
    // exact for a lone value, with a band of zero width
    {
      const t = make(8192);
      for (let i = 0; i < 9; i++) t.ingest({ op: "insert", value: 77 });
      expect(t.query({ kind: "frequency", value: 77 })).toMatchObject({ estimate: 9, low: 9, high: 9 });
      t.ingest({ op: "delete", value: 77 });
      expect(t.query({ kind: "frequency", value: 77 })).toMatchObject({ estimate: 8, low: 8, high: 8 });
    }
    // the list keeps the heaviest values: a full list gives way to a value that is heavier than its weakest, not to a lighter one
    {
      const t = make(32 * 32 * 4 + 3 * 96 * 4 /* room for 3 entries at a quarter share */, 4);
      expect(t.params.candidates).toBeGreaterThanOrEqual(3);
      const room = t.params.candidates as number;
      for (let v = 1; v <= room; v++) for (let i = 0; i < 5; i++) t.ingest({ op: "insert", value: v });
      for (let i = 0; i < 20; i++) t.ingest({ op: "insert", value: 999 }); // heavier than all of them
      expect(t.candidates.some((c) => c.value === 999)).toBe(true);
      expect(t.candidates).toHaveLength(room);
      for (let i = 0; i < 2; i++) t.ingest({ op: "insert", value: 5000 }); // lighter than the weakest: stays off the list
      expect(t.candidates.some((c) => c.value === 5000)).toBe(false);
    }
    // deleting a value away frees its place
    {
      const t = make(8192);
      t.ingest({ op: "insert", value: 4 });
      expect(t.candidates).toHaveLength(1);
      t.ingest({ op: "delete", value: 4 });
      expect(t.candidates).toHaveLength(0);
      t.ingest({ op: "delete", value: 4 }); // a delete of something not on the list is harmless
    }
    // answers only Frequency, and a value off the list is answered by the grid
    {
      const t = make(8192);
      expect(t.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(t.query({ kind: "count" })).toBeNull();
      expect(t.query({ kind: "frequency", value: 3 })).toMatchObject({ estimate: 0, low: 0, high: 0 });
    }
    // too little Space for even one entry
    {
      expect(() => make(100)).toThrow(RangeError);
    }
  });

  it("snapshots to JSON and back, and clones independently", () => {
    const t = make(8192, 4);
    for (let v = 0; v < 60; v++) for (let i = 0; i <= v % 5; i++) t.ingest({ op: "insert", value: v });
    const back = TopKTracker.fromSnapshot(JSON.parse(JSON.stringify(t.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(t.snapshot());
    expect(back.query({ kind: "frequency", value: 3 })).toEqual(t.query({ kind: "frequency", value: 3 }));
    const copy = t.clone();
    copy.ingest({ op: "insert", value: 3 });
    expect(t.snapshot()).not.toEqual(copy.snapshot());
    expect(() => TopKTracker.fromSnapshot({ ...t.snapshot(), kind: "countSketch" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => TopKTracker.fromSnapshot({ ...t.snapshot(), state: { ...t.snapshot().state, grid: 5 } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const universe = 300;
    const events = 3000;
    const space = 8192;

    function runTrial(t: number, skewed: boolean) {
      const rng = trialRng(skewed ? "topk-skewed" : "topk-flat", t);
      const values = distinctValues(rng, universe);
      const tracker = make(space, 4);
      const grid = new CountMinSketch({ spaceBits: space, knob: 4 }, TEST_CONSTANTS);
      const { events: stream, live } = churnStream(rng, values, events, 0.1, { skewed });
      for (const e of stream) {
        tracker.ingest(e);
        grid.ingest(e);
      }
      return { tracker, grid, values, live };
    }

    it("never reports an upper bound below the truth, and its lower bound holds at the grid's confidence", () => {
      let below = 0;
      let covered = 0;
      let total = 0;
      let fractional = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { tracker, values, live } = runTrial(t, true);
        fractional += tracker.candidates.filter((c) => !Number.isInteger(c.low) || !Number.isInteger(c.high)).length; // a fractional bound once broke snapshots
        for (const v of values) {
          const a = tracker.query({ kind: "frequency", value: v });
          const truth = live.count(v);
          if (a && a.high < truth) below++;
          if (a && a.low <= truth && truth <= a.high) covered++;
          total++;
        }
      }
      expect(below).toBe(0);
      expect(fractional).toBe(0);
      // The whole state survives JSON after a real stream: every bound is a whole number (a fractional one once broke snapshots).
      const { tracker } = runTrial(0, true);
      const back = TopKTracker.fromSnapshot(JSON.parse(JSON.stringify(tracker.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(tracker.snapshot());
      expect(covered / total).toBeGreaterThanOrEqual(coverageFloor(1 - Math.exp(-4), TRIALS));
    });

    it("answers the heaviest values at least twice as accurately as a Count-Min of the same Space on a skewed stream, which is what the list is for", () => {
      let gridError = 0;
      let trackerError = 0;
      let n = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { tracker, grid, values, live } = runTrial(t, true);
        for (const v of [...values].sort((a, b) => live.count(b) - live.count(a)).slice(0, 5)) {
          gridError += Math.abs(grid.estimate(v) - live.count(v));
          trackerError += Math.abs((tracker.query({ kind: "frequency", value: v })?.estimate as number) - live.count(v));
          n++;
        }
      }
      expect(trackerError / n).toBeLessThan((gridError / n) / 2);
    });

    it("gains nothing on a flat stream, where no value is heavy and the grid it gives up Space for is smaller", () => {
      let gridError = 0;
      let trackerError = 0;
      let n = 0;
      for (let t = 0; t < TRIALS; t++) {
        const { tracker, grid, values, live } = runTrial(t, false);
        for (const v of [...values].sort((a, b) => live.count(b) - live.count(a)).slice(0, 5)) {
          gridError += Math.abs(grid.estimate(v) - live.count(v));
          trackerError += Math.abs((tracker.query({ kind: "frequency", value: v })?.estimate as number) - live.count(v));
          n++;
        }
      }
      expect(trackerError / n).toBeGreaterThan((gridError / n) * 0.8); // not better than the plain grid by any real margin
    });
  });
});
