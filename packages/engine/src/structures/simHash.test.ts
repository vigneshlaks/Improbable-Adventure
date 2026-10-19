import { describe, expect, it } from "vitest";
import { MinHash } from "./minHash";
import { binomialUpper } from "../stats/stats";
import { SimHash } from "./simHash";
import { churnStream, coverageFloor, distinctValues, likenessChallenge, TEST_CONSTANTS, trialRng } from "./testUtils";
import { trueAnswer } from "../combat/challenges";
import type { Challenge } from "./types";

const make = (spaceBits: number, hashSeed?: number) => new SimHash({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: SimHash, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("SimHash", () => {
  it("has a plane for each 16 bits (in whole 32-bit hashes), at least a 64-bit fingerprint; sees no difference between a stream and the same set of values, and half the planes differ for a set with nothing in common; counts deletes without acting; answers only Likeness; and snapshots, clones", () => {
    {
      expect(make(8192).params).toEqual({ planes: 512 });
      expect(make(8192).spaceBits()).toBe(8192);
      expect(make(1024).params).toEqual({ planes: 64 });
      expect(make(8500).params).toEqual({ planes: 512 }); // whole 32-bit hashes: 8,500 / 16 is 531, rounded down to 512
      expect(() => make(1000)).toThrow(RangeError);
    }
    // the same set: every counter has the sign of the copy's sum, so nothing differs; strangers differ in about half the planes; an empty stream and a copy differ nowhere or everywhere
    {
      const s = make(8192);
      const values = distinctValues(trialRng("simhash-same", 0), 300);
      feed(s, values);
      expect(s.differing(values)).toBe(0);
      expect(s.differing([...values].reverse())).toBe(0);
      expect(s.differing([...values, ...values.slice(0, 40)])).toBe(0); // a repeated value in a copy counts once
      const strangers = distinctValues(trialRng("simhash-strangers", 0), 300);
      expect(Math.abs(s.differing(strangers) - 0.5)).toBeLessThan(4 * Math.sqrt(0.25 / 512));
      expect(s.effectiveSize()).toBeCloseTo(300, -1); // each value once: 300 values
    }
    // the effective size: a stream that repeats one value looks small (weak on duplicates), and an empty one is nothing
    {
      expect(make(8192).effectiveSize()).toBe(0);
      const s = make(8192);
      for (let i = 0; i < 300; i++) s.ingest({ op: "insert", value: i < 150 ? 7 : 1000 + i });
      expect(s.effectiveSize()).toBeLessThan(10); // 150 repeats of one value outweigh 150 others
    }
    // surely real: the identical copy has similarity at its angle's far end, cos(pi e) with e the Hoeffding half-width for its share of half the
    // miss chance, and a quarter of the miss chance bounds the ghosts after deletes; the threshold is moved across each edge
    {
      const s = make(8192);
      const values = distinctValues(trialRng("simhash-edge", 0), 300);
      feed(s, values);
      const e = Math.sqrt(Math.log((2 * 2) / 0.025) / (2 * 512));
      const size = s.effectiveSize();
      const edge = SimHash.similarityAt(e, size, 300);
      const at = (threshold: number) => s.query({ kind: "likeness", targets: [0, 1], copies: [values, distinctValues(trialRng("simhash-edge", 1), 300)], threshold });
      expect(at(edge - 0.002)).toMatchObject({ estimate: [0], low: 1, high: 1 });
      expect(at(edge + 0.002)).toMatchObject({ estimate: [0], low: 0, high: 1 });
      // after 90 deletes of 300 units, the ghosts the deletes allow for are taken off the edge
      for (let i = 0; i < 90; i++) s.ingest({ op: "delete", value: values[i] as number });
      const n = s.inserts;
      const ghosts = Math.min(1, binomialUpper(n, 90 / n, 1 - 0.05 / 4) / n);
      expect(ghosts).toBeGreaterThan(0.2);
      const edgeAfter = edge - ghosts; // the effective size does not change with deletes
      expect(at(edgeAfter - 0.002)).toMatchObject({ low: 1 });
      expect(at(edgeAfter + 0.002)).toMatchObject({ low: 0 });
    }
    // deletes are counted and change nothing else
    {
      const s = make(8192);
      feed(s, distinctValues(trialRng("simhash-del", 0), 100));
      const before = JSON.stringify(s.snapshot());
      s.ingest({ op: "delete", value: 5 });
      expect(s.deletes).toBe(1);
      expect(JSON.stringify(s.snapshot()).replace('"deletes":1', '"deletes":0')).toBe(before);
    }
    // the similarity that goes with an angle: the same set is 1, perpendicular sets share nothing, and half of a set is its square root
    {
      expect(SimHash.similarityAt(0, 100, 100)).toBe(1);
      expect(SimHash.similarityAt(0.5, 100, 100)).toBeCloseTo(0, 12);
      expect(SimHash.similarityAt(1 / 3, 400, 400)).toBeCloseTo(200 / 600, 6); // cos 60 degrees = 0.5, shared 200, union 600
    }
    // only Likeness
    {
      for (const challenge of [{ kind: "presence", targets: [1] }, { kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(make(8192).query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores; a clone is independent; bad ones are refused
    {
      const s = make(4096);
      feed(s, distinctValues(trialRng("simhash-snap", 0), 200));
      const back = SimHash.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      expect(back.differing([1, 2, 3])).toBe(s.differing([1, 2, 3]));
      const copy = s.clone();
      feed(copy, [99]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => SimHash.fromSnapshot({ ...s.snapshot(), kind: "minHash" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => SimHash.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, counters: [1] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 300;

    it("estimates the angle between a stream and a set from the planes that differ: the share has the mean the angle gives and the spread of a binomial of P planes, at several overlaps", () => {
      const planes = 512;
      for (const overlap of [0.2, 0.5, 0.8]) {
        // a stream of 400 values and a copy of 400 sharing `overlap` of them: cos = overlap, the share is acos(overlap) / pi
        const shared = Math.round(400 * overlap);
        const expected = Math.acos(shared / 400) / Math.PI;
        const shares: number[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`simhash-angle-${overlap}`, t);
          const values = distinctValues(rng, 800 - shared);
          const s = make(planes * 16, rng.next());
          feed(s, values.slice(0, 400));
          shares.push(s.differing([...values.slice(0, shared), ...values.slice(400)]));
        }
        const mean = shares.reduce((a, b) => a + b, 0) / TRIALS;
        const sd = Math.sqrt(shares.reduce((a, b) => a + (b - mean) ** 2, 0) / TRIALS);
        const theory = Math.sqrt(expected * (1 - expected) / planes);
        expect(Math.abs(mean - expected), `overlap ${overlap}`).toBeLessThan((4 * theory) / Math.sqrt(TRIALS) + 0.003);
        expect(sd, `overlap ${overlap}`).toBeLessThan(theory * 1.2);
        expect(sd, `overlap ${overlap}`).toBeGreaterThan(theory * 0.6);
      }
    });

    it("never calls a decoy real beyond the chance its range allows, keeps its range at the stated confidence, and is the rougher of the two Likeness structures: on streams without repeats it classifies most copies right, MinHash nearly all, and on streams where a few values repeat a lot it flags little (weak on duplicates)", () => {
      for (const churn of [0, 0.2]) {
        for (const skewed of [false, true]) {
          const trials = 100;
          let covered = 0;
          let asked = 0;
          let right = 0;
          let minRight = 0;
          let copies = 0;
          let decoysFlagged = 0;
          for (let t = 0; t < trials; t++) {
            const rng = trialRng(`simhash-cover-${churn}-${skewed}`, t);
            const values = distinctValues(rng, 500);
            const { events, live } = churnStream(rng, values, 900, churn, { skewed });
            const challenge = likenessChallenge(live, rng);
            if (!challenge) continue;
            asked++;
            const sim = make(8192);
            const min = new MinHash({ spaceBits: 8192 }, TEST_CONSTANTS);
            for (const e of events) {
              sim.ingest(e);
              min.ingest(e);
            }
            const answer = sim.query(challenge);
            const flagged = (answer?.estimate ?? []) as number[];
            const truth = trueAnswer(challenge, live);
            if (truth.kind !== "likeness" || !answer) throw new Error("expected a likeness answer");
            if (answer.low <= flagged.filter((c) => truth.real[c]).length && flagged.filter((c) => truth.real[c]).length <= answer.high) covered++;
            const minFlagged = (min.query(challenge)?.estimate ?? []) as number[];
            for (let c = 0; c < truth.real.length; c++) {
              copies++;
              if (flagged.includes(c) === truth.real[c]) right++;
              if (minFlagged.includes(c) === truth.real[c]) minRight++;
              if (flagged.includes(c) && !truth.real[c]) decoysFlagged++;
            }
          }
          expect(covered / asked, `churn ${churn} skewed ${skewed}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, asked));
          expect(decoysFlagged / copies, `churn ${churn} skewed ${skewed}`).toBeLessThan(0.05);
          expect(minRight / copies).toBeGreaterThan(right / copies);
          if (!skewed) expect(right / copies, `churn ${churn}`).toBeGreaterThan(0.7);
          else expect(right / copies, `churn ${churn}`).toBeLessThan(0.6);
        }
      }
    });
  });
});
