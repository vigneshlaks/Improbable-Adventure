import { describe, expect, it } from "vitest";
import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
import { KMinimumValues } from "./kMinimumValues";
import { DEFAULT_HASH_SEED } from "./types";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, hashSeed?: number) => new KMinimumValues({ spaceBits, hashSeed }, TEST_CONSTANTS);
const insert = (k: KMinimumValues, v: number) => k.ingest({ op: "insert", value: v });
const estimateOf = (k: KMinimumValues) => k.query({ kind: "count" })?.estimate as number;

describe("KMinimumValues", () => {
  it("costs 32 x k bits; counts exactly while it has seen fewer than k different values, ignoring repeats; then estimates (k - 1) / (the k-th smallest hash as a share of the range); answers only Count; and rejects Space for fewer than three values", () => {
    // costs 32 x k bits
    {
      const s = make(8192);
      expect(s.params).toEqual({ k: 256 });
      expect(s.spaceBits()).toBe(8192);
      expect(make(8200).spaceBits()).toBe(8192); // a partial slot is not used
    }
    // exact below k, and a repeat of a value is not a new value
    {
      const s = make(32 * 50);
      for (let v = 1; v <= 30; v++) insert(s, v * 1009);
      for (let v = 1; v <= 30; v++) insert(s, v * 1009);
      expect(s.query({ kind: "count" })).toMatchObject({ estimate: 30, low: 30, high: 30 });
      expect(s.size).toBe(30);
    }
    // from k on it keeps only the k smallest hashes, and the estimate is (k - 1) over the largest kept hash as a share of 2^32
    {
      const s = make(32 * 50);
      for (let v = 1; v <= 5000; v++) insert(s, v * 7919);
      expect(s.size).toBe(50);
      const largest = s.hashes[49] as number;
      expect(s.estimate()).toBeCloseTo(49 / (largest / 2 ** 32), 6);
      expect(s.standardError).toBeCloseTo(1 / Math.sqrt(48), 12);
      expect([...s.hashes]).toEqual([...s.hashes].sort((a, b) => a - b)); // kept in order
    }
    // keeps exactly the k smallest hashes of whatever it saw, in any order, and its range is the lognormal one around the estimate
    {
      const k = 40;
      const s = make(32 * k);
      const values = distinctValues(trialRng("kmv-smallest", 0), 3000);
      for (const v of values) insert(s, v);
      const smallest = values.map((v) => murmur3U32(v, DEFAULT_HASH_SEED)).sort((a, b) => a - b).slice(0, k);
      expect([...s.hashes]).toEqual(smallest);
      const sigma = Math.sqrt(Math.log(1 + (1 / Math.sqrt(k - 2)) ** 2));
      const z = zForConfidence(TEST_CONSTANTS.confidence);
      const a = s.query({ kind: "count" });
      expect(a?.low).toBeCloseTo(s.estimate() * Math.exp(sigma ** 2 / 2 - z * sigma), 6);
      expect(a?.high).toBeCloseTo(s.estimate() * Math.exp(sigma ** 2 / 2 + z * sigma), 6);
    }
    // a hash that belongs between the last two kept ones takes the place of the last: checked on a sketch of three, with hashes in a known order
    {
      const byHash = distinctValues(trialRng("kmv-order", 0), 50).sort((a, b) => murmur3U32(a, DEFAULT_HASH_SEED) - murmur3U32(b, DEFAULT_HASH_SEED));
      const [v1, v2, v3, v4] = byHash as [number, number, number, number]; // smallest hash first
      const s = make(32 * 3);
      for (const v of [v1, v2, v4]) insert(s, v);
      expect([...s.hashes]).toEqual([v1, v2, v4].map((v) => murmur3U32(v, DEFAULT_HASH_SEED)));
      insert(s, v3);
      expect([...s.hashes]).toEqual([v1, v2, v3].map((v) => murmur3U32(v, DEFAULT_HASH_SEED))); // v3 pushed v4 out
      insert(s, byHash[49] as number); // the largest hash of all is not kept
      expect([...s.hashes]).toEqual([v1, v2, v3].map((v) => murmur3U32(v, DEFAULT_HASH_SEED)));
    }
    // answers only Count, and ignores deletes as a structure, only counting them
    {
      const s = make(8192);
      expect(s.query({ kind: "presence", targets: [1] })).toBeNull();
      expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
      for (let v = 1; v <= 10; v++) insert(s, v);
      s.ingest({ op: "delete", value: 1 });
      expect(s.deletes).toBe(1);
      expect(s.size).toBe(10); // a deleted value is still in the table: that is the ghost
      expect(estimateOf(s)).toBeLessThan(10); // the estimate allows for it
    }
    // too little Space for three values
    {
      expect(() => make(64)).toThrow(RangeError);
    }
  });

  it("snapshots to JSON and back, clones independently, and merges into the k smallest of both: the sketch of the union", () => {
    const a = make(32 * 40, 7);
    const b = make(32 * 40, 7);
    const both = make(32 * 40, 7);
    for (let v = 0; v < 600; v++) {
      insert(v % 2 === 0 ? a : b, v * 31 + 5);
      insert(both, v * 31 + 5);
    }
    const back = KMinimumValues.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(a.snapshot());
    const copy = a.clone();
    insert(copy, 99999);
    expect(a.snapshot()).not.toEqual(copy.snapshot());
    expect([...a.merge(b).hashes]).toEqual([...both.hashes]); // as if one sketch had seen everything
    expect(() => a.merge(make(32 * 40, 8))).toThrow();
    expect(() => a.merge(make(32 * 41, 7))).toThrow();
    expect(() => KMinimumValues.fromSnapshot({ ...a.snapshot(), kind: "logLog" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => KMinimumValues.fromSnapshot({ ...a.snapshot(), state: { ...a.snapshot().state, hashes: [5, 3] } }, TEST_CONSTANTS)).toThrow(RangeError); // not in order
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const space = 8192; // k = 256, a standard error of 6.3 percent
    const k = 256;

    it("is unbiased and its relative error is about 1 / sqrt(k - 2)", () => {
      let sum = 0;
      let squares = 0;
      const distinct = 5000;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("kmv-error", t);
        const s = make(space);
        for (const v of distinctValues(rng, distinct)) insert(s, v);
        const error = (estimateOf(s) - distinct) / distinct;
        sum += error;
        squares += error ** 2;
      }
      const theory = 1 / Math.sqrt(k - 2);
      expect(Math.abs(sum / TRIALS)).toBeLessThan(3 * theory / Math.sqrt(TRIALS)); // the mean error is within chance of zero
      expect(Math.sqrt(squares / TRIALS)).toBeGreaterThan(0.85 * theory);
      expect(Math.sqrt(squares / TRIALS)).toBeLessThan(1.15 * theory);
    });

    it("reports a range that holds the truth at the stated confidence, with no deletes and with Churn", () => {
      for (const churn of [0, 0.1, 0.3]) {
        let covered = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`kmv-cover-${churn}`, t);
          const values = distinctValues(rng, 4000);
          const s = make(space);
          const { events, live } = churnStream(rng, values, 6000, churn);
          for (const e of events) s.ingest(e);
          const a = s.query({ kind: "count" });
          if (a && a.low <= live.distinct && live.distinct <= a.high) covered++;
        }
        expect(covered / TRIALS, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      }
    });
  });
});
