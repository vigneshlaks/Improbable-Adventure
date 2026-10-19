import { describe, expect, it } from "vitest";
import { binomialUpper } from "../stats/stats";
import { QuotientFilter } from "./quotientFilter";
import { churnStream, coverageFloor, distinctValues, presenceTargets, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Challenge } from "./types";

const make = (spaceBits: number, knob?: number, hashSeed?: number) => new QuotientFilter({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);
const insert = (s: QuotientFilter, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));
const flagged = (s: QuotientFilter, targets: number[]) => (s.query({ kind: "presence", targets })?.estimate as number[]).length;

describe("QuotientFilter", () => {
  it("takes the most quotient bits that fit (2^q slots of r + 3 bits); never misses a value it took in; spends a slot on every insert, repeats too; takes one copy off for a delete and no more; drops an insert when full and says so; merges with a filter of the same shape; answers only Presence; and snapshots, clones", () => {
    // sizes: 2^q (r + 3) bits, q as large as fits; the knob is r
    {
      const s = make(8192);
      expect(s.params).toEqual({ quotientBits: 9, remainderBits: 8, slots: 512 });
      expect(s.spaceBits()).toBe(512 * 11);
      expect(make(8192, 4).params).toMatchObject({ quotientBits: 10, remainderBits: 4, slots: 1024 });
      expect(make(1024 * 11).params.quotientBits).toBe(10); // exactly enough Space for 2^10 slots
      expect(make(1024 * 11 - 1).params.quotientBits).toBe(9);
      expect(() => make(8192, 0)).toThrow(RangeError);
      expect(() => make(8192, 17)).toThrow(RangeError);
      expect(() => make(40)).toThrow(RangeError);
    }
    // no false negatives; a repeat takes a slot; a delete takes one copy
    {
      const s = make(8192);
      const values = distinctValues(trialRng("quotient-members", 0), 200);
      insert(s, values);
      expect(flagged(s, values)).toBe(200);
      insert(s, values.slice(0, 50));
      expect(s.size).toBe(250);
      s.ingest({ op: "delete", value: values[0] as number });
      expect(flagged(s, [values[0] as number])).toBe(1); // a second copy is left
      s.ingest({ op: "delete", value: values[0] as number });
      expect(flagged(s, [values[0] as number])).toBe(0);
      expect(s.size).toBe(248);
      s.ingest({ op: "delete", value: 424242 }); // never inserted: nothing to take (unless a look-alike is there)
      expect(s.size).toBeGreaterThanOrEqual(247);
    }
    // the false-positive rate counts distinct fingerprints, not entries: a value repeated a hundred times is one fingerprint
    {
      const s = make(8192);
      for (let i = 0; i < 100; i++) s.ingest({ op: "insert", value: 5 });
      expect(s.size).toBe(100);
      expect(s.falsePositiveRate()).toBe(1 / 2 ** (9 + 8));
    }
    // the range allows for what deletes may have taken wrongly (a look-alike's fingerprint) as well as for what a full table dropped
    {
      const s = make(2048, 2); // two remainder bits: look-alikes are common
      const values = distinctValues(trialRng("quotient-hidden", 0), 150);
      insert(s, values);
      for (const value of values.slice(0, 100)) s.ingest({ op: "delete", value });
      const targets = distinctValues(trialRng("quotient-hidden", 1), 20);
      const answer = s.query({ kind: "presence", targets });
      const hits = (answer?.estimate as number[]).length;
      const hidden = Math.min(targets.length - hits, s.lost + binomialUpper(100, s.falsePositiveRate(), 0.95));
      expect(hidden).toBeGreaterThan(0);
      expect(answer?.high).toBe(Math.min(targets.length, hits + hidden));
    }
    // full: the next insert is dropped, counted, and hides its value (a false negative)
    {
      const s = make(8192, 8);
      const values = distinctValues(trialRng("quotient-full", 0), 600);
      insert(s, values);
      expect(s.size).toBe(512);
      expect(s.lost).toBe(88);
      expect(s.load).toBe(1);
      const answer = s.query({ kind: "presence", targets: values.slice(520, 540) });
      expect(answer?.high).toBeGreaterThanOrEqual(Math.min(20, (answer?.estimate as number[]).length + 20)); // the hidden values are allowed for
      expect(flagged(s, values.slice(0, 512))).toBe(512);
    }
    // a merge holds both filters' fingerprints, drops what does not fit, and refuses another shape or seed
    {
      const a = make(8192);
      const b = make(8192);
      const left = distinctValues(trialRng("quotient-merge", 0), 100);
      const right = distinctValues(trialRng("quotient-merge", 1), 100);
      insert(a, left);
      insert(b, right);
      const both = a.merge(b);
      expect(flagged(both, [...left, ...right])).toBe(200);
      expect(both.size).toBe(200);
      expect(a.size).toBe(100); // the originals are not changed
      expect(() => a.merge(make(8192, 4))).toThrow();
      expect(() => a.merge(make(8192, 8, 5))).toThrow();
      const small = make(1024, 8);
      const filled = make(1024, 8);
      insert(small, distinctValues(trialRng("quotient-full-merge", 0), 100));
      insert(filled, distinctValues(trialRng("quotient-full-merge", 1), 100));
      expect(small.size).toBe(64); // a full table of 64 slots
      const merged = small.merge(filled);
      expect(merged.size).toBe(64);
      expect(merged.lost).toBe(small.lost + filled.lost + filled.size); // both filters' losses, and every fingerprint of the second, which had nowhere to go
    }
    // only Presence
    {
      for (const challenge of [{ kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(make(8192).query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores; a clone is independent; bad ones are refused
    {
      const s = make(8192);
      insert(s, distinctValues(trialRng("quotient-snap", 0), 120));
      s.ingest({ op: "delete", value: 9 });
      const back = QuotientFilter.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      const copy = s.clone();
      insert(copy, [1234567]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => QuotientFilter.fromSnapshot({ ...s.snapshot(), kind: "cuckooFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => QuotientFilter.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, fingerprints: [1] } }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => QuotientFilter.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, fingerprints: [2 ** 30, 1] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 300;

    it("flags a never-inserted value at the rate it reports, n / 2^(q + r), for several remainder sizes and loads (observed within 1.3 times plus noise), which is the load times 2^-r the spec gives", () => {
      for (const r of [4, 6, 8]) {
        for (const items of [100, 250]) {
          let observed = 0;
          let reported = 0;
          for (let t = 0; t < TRIALS; t++) {
            const rng = trialRng(`quotient-fp-${r}-${items}`, t);
            const values = distinctValues(rng, items + 400);
            const s = make(4096, r);
            insert(s, values.slice(0, items));
            observed += flagged(s, values.slice(items)) / 400;
            reported += s.falsePositiveRate();
          }
          expect(observed / TRIALS, `r ${r}, ${items} values`).toBeLessThanOrEqual((reported / TRIALS) * 1.3 + 0.002);
          expect(observed / TRIALS, `r ${r}, ${items} values`).toBeGreaterThan((reported / TRIALS) * 0.7 - 0.002);
          expect(reported / TRIALS).toBeLessThanOrEqual(items / 2 ** (make(4096, r).params.quotientBits! + r)); // the rate counts distinct fingerprints, never more than the entries
        }
      }
    });

    it("gives a Presence range that holds the number of real flagged targets at the stated confidence, with Churn", () => {
      for (const churn of [0, 0.2]) {
        let covered = 0;
        for (let t = 0; t < 500; t++) {
          const rng = trialRng(`quotient-cover-${churn}`, t);
          const values = distinctValues(rng, 500);
          const { events, live } = churnStream(rng, values, 900, churn);
          const s = make(8192, 6);
          for (const e of events) s.ingest(e);
          const targets = presenceTargets(live, rng);
          const answer = s.query({ kind: "presence", targets });
          const real = (answer?.estimate as number[]).filter((v) => live.count(v) > 0).length;
          const hiddenReal = targets.filter((v) => live.count(v) > 0).length;
          if (answer && answer.low <= real && hiddenReal <= answer.high) covered++;
        }
        expect(covered / 500, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, 500));
      }
    });
  });
});
