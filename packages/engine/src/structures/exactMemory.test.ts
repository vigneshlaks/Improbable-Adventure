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

describe("ExactMemory rank", () => {
  const rank = (m: ExactMemory, quantile: number) => m.query({ kind: "rank", quantile });
  it("answers a Rank challenge exactly from its table, counting every unit of a repeated value; widens the range by the share of units it refused when full; and follows deletes", () => {
    const m = make(64 * 20);
    // ten units: 10 x5, 20 x3, 30 x2
    for (const [value, count] of [[10, 5], [20, 3], [30, 2]] as const) for (let i = 0; i < count; i++) m.ingest({ op: "insert", value });
    expect(rank(m, 0.5)).toMatchObject({ estimate: 10, low: 10, high: 10 });
    expect(rank(m, 0.8)).toMatchObject({ estimate: 20, low: 20, high: 20 });
    expect(rank(m, 1)).toMatchObject({ estimate: 30, low: 30, high: 30 });
    m.ingest({ op: "delete", value: 10 });
    m.ingest({ op: "delete", value: 10 });
    expect(rank(m, 0.5)).toMatchObject({ estimate: 20 }); // eight units now: 10 x3, 20 x3, 30 x2, and 4 of 8 reach the 0.5 quantile at 20
    expect(rank(m, 0.9)).toMatchObject({ estimate: 30 });

    // A table that is full refuses new values; each is an unknown unit that may lie either side, so the range opens by their share.
    const full = make(64 * 4);
    for (const value of [1, 2, 3, 4]) full.ingest({ op: "insert", value }); // four units, all kept
    for (const value of [100, 200]) full.ingest({ op: "insert", value }); // two refused: a share of 2 / 6
    const answer = rank(full, 0.5);
    expect(answer?.estimate).toBe(2);
    expect(answer?.low).toBe(1); // the 0.5 - 1/3 quantile of the kept values
    expect(answer?.high).toBe(4); // the 0.5 + 1/3 quantile
    expect(rank(full, 0.95)?.high).toBe(4);

    // nothing stored: no answer to give
    expect(rank(make(64 * 4), 0.5)).toMatchObject({ estimate: 0, high: Number.POSITIVE_INFINITY });
  });
});

describe("ExactMemory likeness", () => {
  const feed = (s: ExactMemory, values: number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  it("flags the copies whose exact similarity to its table reaches the threshold, and says which are surely real: all of them while it has not refused anything, and fewer by the values it refused when full; forgets deleted values", () => {
    // ten values; copy 0 is all of them (1), copy 1 has five of them and five others (5 / 15), copy 2 nine of them and a stranger (9 / 11), copy 3 is empty
    const copies = [range(1, 11), [...range(1, 6), ...range(100, 105)], [...range(1, 10), 99], []];
    const challenge = { kind: "likeness" as const, targets: [0, 1, 2, 3], copies, threshold: 0.6 };
    const s = make(64 * 20);
    feed(s, range(1, 11));
    expect(s.query(challenge)).toEqual({ estimate: [0, 2], low: 2, high: 2, confidence: 0.95 });
    // the equal-to-threshold edge: nine of ten live values and nothing else is 0.9; a threshold of 0.9 flags it
    expect(s.query({ ...challenge, threshold: 0.9 })).toMatchObject({ estimate: [0] });
    expect(s.query({ ...challenge, threshold: 9 / 11 })).toMatchObject({ estimate: [0, 2] });
    // deleting a value removes it from the comparison: with value 10 gone copy 0 shares nine of ten, copy 2 nine of eleven
    {
      const t = s.clone();
      t.ingest({ op: "delete", value: 10 });
      expect(t.query({ ...challenge, threshold: 0.95 })).toMatchObject({ estimate: [] });
      expect(t.query(challenge)).toMatchObject({ estimate: [0, 2] });
    }
    // a table of ten values given twelve: two refused. A copy at 0.9 might be as low as 9 / (11 + 2); the surely-real count is the flagged ones still reaching the threshold then
    {
      const full = make(64 * 10);
      feed(full, range(1, 13));
      expect(full.refused).toBe(2);
      // copy 0 (values 1..10) has I = 10, U = 10: 10 / 12 = 0.83 >= 0.6, surely real; copy 2 has I = 9, U = 11: 9 / 13 = 0.69 >= 0.6, surely real
      expect(full.query(challenge)).toMatchObject({ estimate: [0, 2], low: 2, high: 2 });
      // at a threshold of 0.75 copy 0 is surely real (10 / 12 = 0.83) but copy 2 (9 / 13 = 0.69) is only flagged (9 / 11 = 0.82)
      expect(full.query({ ...challenge, threshold: 0.75 })).toMatchObject({ estimate: [0, 2], low: 1, high: 2 });
    }
  });
});
