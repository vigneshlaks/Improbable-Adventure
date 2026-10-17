import { describe, expect, it } from "vitest";
import { ExactMemory } from "./exactMemory";
import { distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number) => new ExactMemory({ spaceBits }, TEST_CONSTANTS);

describe("ExactMemory", () => {
  it("costs VALUE_BITS + a 32-bit counter (64 bits) per distinct value; rejects Space too small for one value; answers presence, frequency and count exactly; and 3 more", () => {
    // costs VALUE_BITS + a 32-bit counter (64 bits) per distinct value
    {
      const s = make(64 * 10 + 63);
      expect(s.params).toEqual({ capacity: 10 });
      expect(s.spaceBits()).toBe(640);
    }
    // rejects Space too small for one value
    {
      expect(() => make(63)).toThrow(RangeError);
    }
    // answers presence, frequency and count exactly
    {
      const s = make(64 * 20);
      for (const v of [5, 5, 5, 9, 11]) s.ingest({ op: "insert", value: v });
      expect(s.query({ kind: "frequency", value: 5 })).toMatchObject({ estimate: 3, low: 3, high: 3 });
      expect(s.query({ kind: "count" })).toMatchObject({ estimate: 3, low: 3, high: 3 });
      expect(s.query({ kind: "presence", targets: [5, 6, 9, 10] })).toMatchObject({ estimate: [5, 9], low: 2, high: 2 });
    }
    // handles deletes, freeing the slot when a count reaches zero
    {
      const s = make(64 * 2);
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "insert", value: 1 });
      s.ingest({ op: "delete", value: 1 });
      expect(s.query({ kind: "frequency", value: 1 })?.estimate).toBe(1);
      s.ingest({ op: "delete", value: 1 });
      expect(s.query({ kind: "presence", targets: [1] })?.estimate).toEqual([]);
      expect(s.size).toBe(0);
      s.ingest({ op: "delete", value: 99 }); // never inserted: ignored
      expect(s.size).toBe(0);
    }
    // refuses new values when full and widens its bounds honestly
    {
      const s = make(64 * 2);
      for (const v of [1, 2, 3, 4]) s.ingest({ op: "insert", value: v });
      expect(s.size).toBe(2);
      expect(s.refused).toBe(2);
      s.ingest({ op: "insert", value: 1 }); // existing values still count
      expect(s.query({ kind: "frequency", value: 1 })?.estimate).toBe(2);
      const count = s.query({ kind: "count" });
      expect(count).toMatchObject({ estimate: 2, low: 2, high: 4 });
      expect(s.query({ kind: "presence", targets: [3, 4, 7] })).toMatchObject({ estimate: [], low: 0, high: 2 });
    }
    // clones independently
    {
      const s = make(64 * 4);
      s.ingest({ op: "insert", value: 1 });
      const c = s.clone();
      c.ingest({ op: "insert", value: 2 });
      expect(s.size).toBe(1);
      expect(c.size).toBe(2);
    }
  });

  it(`statistical: exact over ${TRIALS} seeded trials with inserts and deletes while under capacity`, () => {
    let wrong = 0;
    for (let t = 0; t < TRIALS; t++) {
      const rng = trialRng("exact", t);
      const universe = distinctValues(rng, 40);
      const s = make(64 * 40);
      const truth = new Map<number, number>();
      for (let i = 0; i < 300; i++) {
        const v = universe[rng.int(universe.length)] ?? 0;
        const live = truth.get(v) ?? 0;
        if (live > 0 && rng.float() < 0.25) {
          s.ingest({ op: "delete", value: v });
          truth.set(v, live - 1);
        } else {
          s.ingest({ op: "insert", value: v });
          truth.set(v, live + 1);
        }
      }
      const liveDistinct = [...truth.values()].filter((c) => c > 0).length;
      if (s.query({ kind: "count" })?.estimate !== liveDistinct) wrong++;
      for (const [v, c] of truth) if (s.query({ kind: "frequency", value: v })?.estimate !== c) wrong++;
    }
    expect(wrong).toBe(0);
  });
});
