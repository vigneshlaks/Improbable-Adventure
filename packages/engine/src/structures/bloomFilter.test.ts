import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { BloomFilter, bloomFalsePositiveRate, bloomOptimalK } from "./bloomFilter";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, presenceTargets, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, knob?: number, hashSeed?: number) =>
  new BloomFilter({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);

describe("BloomFilter", () => {
  it("derives k = round((m/n) ln 2) from Space and expected items; matches the textbook false-positive formula; has no false negatives, and flags only some decoys; and 5 more", () => {
    // derives k = round((m/n) ln 2) from Space and expected items
    {
      expect(make(8192, 800).params).toEqual({ m: 8192, k: 7, expectedItems: 800 });
      expect(bloomOptimalK(1000, 100)).toBe(7);
      expect(bloomOptimalK(10, 1000)).toBe(1); // never below one hash
      expect(make(1000).spaceBits()).toBe(1000);
    }
    // matches the textbook false-positive formula
    {
      // 10 bits per item, k = 7: about 0.82%.
      expect(bloomFalsePositiveRate(1000, 100, 7)).toBeCloseTo(0.0082, 3);
    }
    // has no false negatives, and flags only some decoys
    {
      const b = make(4096, 400);
      const rng = trialRng("bloom-unit", 0);
      const values = distinctValues(rng, 600);
      const real = values.slice(0, 400);
      const decoys = values.slice(400);
      for (const v of real) b.ingest({ op: "insert", value: v });
      const answer = b.query({ kind: "presence", targets: real });
      expect(answer?.estimate).toEqual(real);
      const decoyFlags = (b.query({ kind: "presence", targets: decoys })?.estimate as number[]).length;
      expect(decoyFlags).toBeLessThan(20);
    }
    // ignores deletes, so deleted values stay flagged as ghosts
    {
      const b = make(2048, 100);
      b.ingest({ op: "insert", value: 77 });
      b.ingest({ op: "delete", value: 77 });
      expect(b.query({ kind: "presence", targets: [77] })?.estimate).toEqual([77]);
    }
    // cannot answer frequency or count
    {
      const b = make(256);
      expect(b.query({ kind: "frequency", value: 1 })).toBeNull();
      expect(b.query({ kind: "count" })).toBeNull();
    }
    // depends on the hash seed: seeded filters set different bits and refuse to merge
    {
      // A deliberately crowded filter (about 5% false positives) so decoy hits are common.
      const a = make(256, 40, 1);
      const c = make(256, 40, 2);
      const values = distinctValues(trialRng("bloom-seed", 0), 40);
      for (const v of values) {
        a.ingest({ op: "insert", value: v });
        c.ingest({ op: "insert", value: v });
      }
      // Same inserts, but a value that collides under seed 1 need not collide under seed 2.
      const probes = distinctValues(trialRng("bloom-seed-probe", 0), 3000);
      const hitsA = new Set((a.query({ kind: "presence", targets: probes })?.estimate as number[]));
      const hitsC = new Set((c.query({ kind: "presence", targets: probes })?.estimate as number[]));
      const both = [...hitsA].filter((v) => hitsC.has(v)).length;
      expect(hitsA.size).toBeGreaterThan(0);
      expect(both).toBeLessThan(hitsA.size);
      expect(() => a.merge(c)).toThrow();
    }
    // clones independently and merges by bitwise OR
    {
      const a = make(1024, 50);
      const b = make(1024, 50);
      a.ingest({ op: "insert", value: 1 });
      b.ingest({ op: "insert", value: 2 });
      const copy = a.clone();
      copy.ingest({ op: "insert", value: 3 });
      expect(a.query({ kind: "presence", targets: [3] })?.estimate).toEqual([]);
      const merged = a.merge(b);
      expect(merged.query({ kind: "presence", targets: [1, 2] })?.estimate).toEqual([1, 2]);
      expect(merged.fill).toBeGreaterThanOrEqual(Math.max(a.fill, b.fill));
      expect(() => a.merge(make(2048, 50))).toThrow();
    }
    // rejects Space of zero
    {
      expect(() => make(0)).toThrow(RangeError);
    }
  });

  describe("deletes it cannot see", () => {
    // A roomy filter, so hash collisions are negligible and any shortfall is due to ghosts.
    const roomy = () => make(4096, 100);
    const inserted = [11, 22, 33];

    it("counts the delete events it ignores; widens the low bound by min(deletes seen, targets flagged), and leaves the high bound alone; carries the delete count through clone and merge; and 1 more", () => {
      // counts the delete events it ignores
      {
        const b = roomy();
        expect(b.deletes).toBe(0);
        for (const v of inserted) b.ingest({ op: "insert", value: v });
        b.ingest({ op: "delete", value: 11 });
        b.ingest({ op: "delete", value: 11 });
        expect(b.deletes).toBe(2);
        expect(b.query({ kind: "presence", targets: [11] })?.estimate).toEqual([11]); // still flagged: a ghost
      }
      // widens the low bound by min(deletes seen, targets flagged), and leaves the high bound alone
      {
        const lowAfter = (deletes: number) => {
          const b = roomy();
          for (const v of inserted) b.ingest({ op: "insert", value: v });
          for (let i = 0; i < deletes; i++) b.ingest({ op: "delete", value: 11 });
          const answer = b.query({ kind: "presence", targets: [...inserted, 777, 888] });
          expect(answer?.high).toBe(3);
          return answer?.low;
        };
        expect(lowAfter(0)).toBe(3); // unchanged without deletes: all three flagged, no collisions to allow for
        expect(lowAfter(1)).toBe(2);
        expect(lowAfter(2)).toBe(1);
        expect(lowAfter(3)).toBe(0);
        expect(lowAfter(50)).toBe(0); // never below zero
      }
      // carries the delete count through clone and merge
      {
        const a = roomy();
        const b = roomy();
        a.ingest({ op: "delete", value: 1 });
        b.ingest({ op: "delete", value: 2 });
        b.ingest({ op: "delete", value: 3 });
        expect(a.clone().deletes).toBe(1);
        expect(a.merge(b).deletes).toBe(3);
      }
      // keeps its Presence range honest when the enemy deletes values (… seeded trials)
      {
        let covered = 0;
        let trialsWithGhostFlags = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng("bloom-ghosts", t);
          const { events, live } = churnStream(rng, distinctValues(rng, 80), 500, 0.4);
          const b = roomy();
          for (const e of events) b.ingest(e);

          const targets = presenceTargets(live, rng);
          const real = targets.filter((target) => live.count(target) > 0).length;
          const answer = b.query({ kind: "presence", targets }) as Answer;
          if (answer.low <= real && real <= answer.high) covered++;
          const flagged = answer.estimate as number[];
          if (flagged.some((target) => live.ghosts().includes(target))) trialsWithGhostFlags++;
        }
        expect(trialsWithGhostFlags / TRIALS).toBeGreaterThan(0.5); // the scenario really does flag ghosts
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      }
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const targetsPerChallenge = 12;

    // Rare false positives need more queries to measure: the k = 14 rate is about 0.005%.
    const configs = [
      { m: 8192, n: 800, queries: 1000 }, // k = 7
      { m: 2048, n: 200, queries: 1000 }, // k = 7, small m
      { m: 5000, n: 700, queries: 1000 }, // k = 5, m not a power of two
      { m: 8000, n: 400, queries: 10000 }, // k = 14, m not a power of two
      { m: 8192, n: 400, queries: 10000 }, // k = 14, power of two
    ];

    const cases: Array<readonly [string, () => void]> = [];
    for (const { m, n, queries } of configs) {
      const k = bloomOptimalK(m, n);
      cases.push([`m = ${m}, n = ${n}, k = ${k}: no false negatives and a false-positive rate that follows (1 - e^(-kn/m))^k`, () => {
        const theory = bloomFalsePositiveRate(m, n, k);
        let falseNegatives = 0;
        let falsePositives = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`bloom-fpr-${m}-${n}`, t);
          const values = distinctValues(rng, n + queries);
          const b = make(m, n);
          for (const v of values.slice(0, n)) b.ingest({ op: "insert", value: v });
          const real = b.query({ kind: "presence", targets: values.slice(0, n) })?.estimate as number[];
          falseNegatives += n - real.length;
          const decoys = b.query({ kind: "presence", targets: values.slice(n) })?.estimate as number[];
          falsePositives += decoys.length;
        }
        expect(falseNegatives).toBe(0);

        const total = TRIALS * queries;
        const observed = falsePositives / total;
        // Allowed gap: four standard deviations of chance, plus 3% of theory.
        // Plain double hashing missed this by 10% to 290% on the small-m and k = 14 configs (see notes/dev).
        const sigma = Math.sqrt(theory * total) / total;
        expect(Math.abs(observed - theory)).toBeLessThanOrEqual(4 * sigma + 0.03 * theory);
      }]);
    }
    it("has no false negatives and a false-positive rate that follows (1 - e^(-kn/m))^k, at every configuration", () => eachCase(cases, (run) => run()));

    it("reports bounds on the real-target count that hold at the stated confidence", () => {
      const m = 8192;
      const n = 800;
      const queries = 1000;
      let covered = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("bloom-cover", t);
        const values = distinctValues(rng, n + queries);
        const b = make(m, n);
        for (const v of values.slice(0, n)) b.ingest({ op: "insert", value: v });
        const half = targetsPerChallenge / 2;
        const targets = [...values.slice(0, half), ...values.slice(n, n + half)];
        const answer = b.query({ kind: "presence", targets });
        if (answer && answer.low <= half && half <= answer.high) covered++;
      }
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });
  });
});
