import { describe, expect, it } from "vitest";
import { MinHash } from "./minHash";
import { churnStream, coverageFloor, distinctValues, likenessChallenge, TEST_CONSTANTS, trialRng } from "./testUtils";
import { trueAnswer } from "../combat/challenges";
import { binomialUpper } from "../stats/stats";
import type { Challenge } from "./types";

const make = (spaceBits: number, hashSeed?: number) => new MinHash({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: MinHash, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("MinHash", () => {
  it("costs 32 bits per slot; keeps only the minima, so repeats and order do not matter; counts deletes without acting; answers only Likeness; flags a copy equal to what it saw and not one that shares nothing; seeds, snapshots and clones as the others do; and estimates the distinct values ever inserted", () => {
    // 32 bits per slot, and too little Space is refused
    {
      expect(make(4096).params).toEqual({ k: 128 });
      expect(make(4096).spaceBits()).toBe(4096);
      expect(make(4100).spaceBits()).toBe(4096);
      expect(() => make(255)).toThrow(RangeError);
    }
    // the same set in any order, with repeats, gives the same minima; another seed gives other minima
    {
      const a = make(2048);
      const b = make(2048);
      const c = make(2048, 12345);
      feed(a, range(0, 300));
      feed(b, [...range(0, 300)].reverse());
      feed(b, range(100, 200));
      feed(c, range(0, 300));
      expect(b.signature).toEqual(a.signature);
      expect(c.signature).not.toEqual(a.signature);
      expect(a.signature.every((m) => m < 2 ** 32)).toBe(true);
      expect(make(2048).signature.every((m) => m === 2 ** 32)).toBe(true); // nothing seen: every slot empty
      // the signature of a copy made on the spot equals the structure's own after seeing the same values
      expect(a.signatureOf(range(0, 300))).toEqual([...a.signature]);
    }
    // deletes are counted and change nothing else
    {
      const a = make(2048);
      feed(a, range(0, 100));
      const before = [...a.signature];
      a.ingest({ op: "delete", value: 5 });
      a.ingest({ op: "delete", value: 77777 });
      expect(a.deletes).toBe(2);
      expect(a.inserts).toBe(100);
      expect([...a.signature]).toEqual(before);
    }
    // answers only Likeness
    {
      const a = make(2048);
      for (const challenge of [{ kind: "presence", targets: [1] }, { kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(a.query(challenge)).toBeNull();
    }
    // a copy equal to the set seen is flagged, and surely real; one with nothing in common is not; with nothing seen nothing is flagged
    {
      const a = make(4096);
      feed(a, range(1000, 1300));
      const challenge: Challenge = { kind: "likeness", targets: [0, 1, 2], copies: [range(1000, 1300), range(5000, 5300), [...range(1000, 1210), ...range(7000, 7090)]], threshold: 0.6 };
      // copy 2 shares 210 of 300 and has 90 extra: 210 / 390 = 0.54, under the threshold
      const answer = a.query(challenge);
      expect(answer).toMatchObject({ estimate: [0], low: 1, high: 1, confidence: 0.95 });
      expect(make(4096).query(challenge)).toMatchObject({ estimate: [], low: 0, high: 0 });
      expect(a.similarity(range(1000, 1300))).toBe(1);
      expect(a.similarity(range(5000, 5300))).toBe(0);
    }
    // a copy equal to the set seen is surely real exactly when 1 - e >= threshold, with e the Hoeffding half-width for the share of the miss
    // chance given to the copies (half of 1 - confidence, shared between the copies): the threshold is moved across that edge
    {
      const a = make(4096);
      feed(a, range(1000, 1300));
      const same = range(1000, 1300);
      for (const copies of [2, 6]) {
        const e = Math.sqrt(Math.log((2 * copies) / (0.05 / 2)) / (2 * 128));
        const others = Array.from({ length: copies - 1 }, (_, i) => range(10000 * (i + 1), 10000 * (i + 1) + 50));
        const at = (threshold: number) => a.query({ kind: "likeness", targets: others.map((_, i) => i + 1).concat(0).sort(), copies: [same, ...others], threshold });
        expect(at(1 - e - 0.002)).toMatchObject({ estimate: [0], low: 1, high: 1 });
        expect(at(1 - e + 0.002)).toMatchObject({ estimate: [0], low: 0, high: 1 });
      }
      expect(a.query({ kind: "likeness", targets: [0], copies: [same], threshold: 1 })).toMatchObject({ estimate: [0] }); // equal to the threshold is flagged
      // an empty structure flags nothing, not even an empty copy
      expect(make(4096).query({ kind: "likeness", targets: [0], copies: [[]], threshold: 0.6 })).toMatchObject({ estimate: [] });
    }
    // deletes widen the allowance: the ghosts the deletes allow for are taken off the surely-real edge, by the share the formula gives
    {
      const a = make(4096);
      feed(a, range(1000, 1300));
      for (let i = 0; i < 90; i++) a.ingest({ op: "delete", value: 1000 + i });
      const e = Math.sqrt(Math.log(12 / 0.025) / 256);
      const n = Math.max(1, Math.floor(a.distinctEver(1 - 0.05 / 4).low));
      const r = Math.min(1, Math.min(90, binomialUpper(n, 90 / 300, 1 - 0.05 / 4)) / n);
      expect(r).toBeGreaterThan(0.1);
      expect(r).toBeLessThan(0.5);
      const same = range(1000, 1300);
      const at = (threshold: number) => a.query({ kind: "likeness", targets: [0, 1, 2, 3, 4, 5], copies: [same, [1], [2], [3], [4], [5]], threshold });
      expect(at(1 - e - r - 0.002)).toMatchObject({ low: 1 });
      expect(at(1 - e - r + 0.002)).toMatchObject({ low: 0 });
    }
    // the ghosts are bounded by the binomial when values repeat, not just by the deletes: 300 values ten times each, 300 units deleted
    {
      const a = make(4096);
      for (let rep = 0; rep < 10; rep++) feed(a, range(1000, 1300));
      for (let i = 0; i < 300; i++) a.ingest({ op: "delete", value: 1000 + i });
      const e = Math.sqrt(Math.log(12 / 0.025) / 256);
      const n = Math.max(1, Math.floor(a.distinctEver(1 - 0.05 / 4).low));
      const ghosts = binomialUpper(n, 300 / 3000, 1 - 0.05 / 4);
      expect(ghosts).toBeLessThan(150); // far fewer than the 300 deletes
      const r = Math.min(1, Math.min(300, ghosts) / n);
      const same = range(1000, 1300);
      const at = (threshold: number) => a.query({ kind: "likeness", targets: [0, 1], copies: [same, [1]], threshold });
      expect(at(1 - Math.sqrt(Math.log(4 / 0.025) / 256) - r - 0.002)).toMatchObject({ low: 1 });
      expect(at(1 - Math.sqrt(Math.log(4 / 0.025) / 256) - r + 0.002)).toMatchObject({ low: 0 });
      void e;
    }
    // a snapshot is JSON and restores to the same answers; a bad one is refused; a clone is independent
    {
      const a = make(2048);
      feed(a, range(0, 400));
      a.ingest({ op: "delete", value: 3 });
      const json = JSON.parse(JSON.stringify(a.snapshot()));
      const back = MinHash.fromSnapshot(json, TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(a.snapshot());
      feed(back, range(400, 500));
      feed(a, range(400, 500));
      expect(back.snapshot()).toEqual(a.snapshot());
      const copy = a.clone();
      feed(copy, [999999]);
      expect(copy.snapshot()).not.toEqual(a.snapshot());
      expect(() => MinHash.fromSnapshot({ ...a.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => MinHash.fromSnapshot({ ...a.snapshot(), state: { ...a.snapshot().state, minima: [1, 2, 3] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
    // the distinct values ever inserted: zero when empty; close for a known number; the lower bound is below the estimate
    {
      expect(make(2048).distinctEver(0.95)).toEqual({ estimate: 0, low: 0 });
      const a = make(8192);
      feed(a, range(0, 2000));
      const { estimate, low } = a.distinctEver(0.975);
      expect(Math.abs(estimate - 2000) / 2000).toBeLessThan(4 / Math.sqrt(254));
      expect(low).toBeLessThan(estimate);
      expect(low).toBeGreaterThan(0.5 * estimate);
      // the formulas: (k - 1) over the sum of -ln(1 - m / 2^32), and a lognormal lower bound at the one-sided level (z for 0.95 is two-sided 1.96)
      const sum = a.signature.reduce((acc, m) => acc + -Math.log1p(-m / 2 ** 32), 0);
      expect(estimate).toBeCloseTo(255 / sum, 9);
      const sigma = Math.sqrt(Math.log(1 + 1 / 254));
      expect(low).toBeCloseTo(estimate * Math.exp(sigma ** 2 / 2 - 1.959964 * sigma), 3);
    }
  });

  describe("statistical", () => {
    const TRIALS = 300;

    it("estimates a Jaccard similarity without bias and with a standard error of at most 1 / (2 sqrt(k)), the bound in the spec, at several similarities", () => {
      const k = 128;
      for (const j of [0.1, 0.5, 0.8]) {
        // two sets of 400 values sharing s of them: J = s / (800 - s), so s = 800 J / (1 + J)
        const shared = Math.round((800 * j) / (1 + j));
        const truth = shared / (800 - shared);
        const estimates: number[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`minhash-error-${j}`, t);
          const values = distinctValues(rng, 800 - shared);
          const left = values.slice(0, 400);
          const right = [...values.slice(0, shared), ...values.slice(400)];
          const s = make(k * 32, rng.next());
          feed(s, left);
          estimates.push(s.similarity(right));
        }
        const mean = estimates.reduce((a, b) => a + b, 0) / TRIALS;
        const sd = Math.sqrt(estimates.reduce((a, b) => a + (b - mean) ** 2, 0) / TRIALS);
        const bound = 1 / (2 * Math.sqrt(k));
        expect(sd, `J ${j}`).toBeLessThanOrEqual(bound * 1.1); // a tenth of slack for the spread of the spread
        expect(sd).toBeGreaterThan(0.3 * Math.sqrt(truth * (1 - truth) / k)); // and it is not trivially small
        expect(Math.abs(mean - truth), `J ${j}`).toBeLessThan((4 * bound) / Math.sqrt(TRIALS));
      }
    });

    it("reports a count of surely real flagged copies that holds at the stated confidence, with no deletes and with Churn, on the challenges the game builds; and the lower bound for the distinct values holds", () => {
      for (const churn of [0, 0.1, 0.3]) {
        let covered = 0;
        let lowCovered = 0;
        let asked = 0;
        let right = 0;
        let copies = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`minhash-cover-${churn}`, t);
          const values = distinctValues(rng, 500);
          const { events, live } = churnStream(rng, values, 900, churn);
          const challenge = likenessChallenge(live, rng);
          if (!challenge) continue;
          asked++;
          const s = make(2048);
          for (const e of events) s.ingest(e);
          const answer = s.query(challenge);
          const truth = trueAnswer(challenge, live);
          if (answer === null || truth.kind !== "likeness" || !Array.isArray(answer.estimate)) throw new Error("expected a flagged subset");
          const flaggedReal = answer.estimate.filter((c) => truth.real[c]).length;
          if (answer.low <= flaggedReal && flaggedReal <= answer.high) covered++;
          for (let c = 0; c < truth.real.length; c++) { copies++; if (answer.estimate.includes(c) === truth.real[c]) right++; }
          const ever = new Set(events.filter((e) => e.op === "insert").map((e) => e.value)).size;
          if (s.distinctEver(0.975).low <= ever) lowCovered++;
        }
        expect(asked).toBeGreaterThan(TRIALS * 0.9);
        expect(covered / asked, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, asked));
        expect(lowCovered / asked, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(0.975, asked));
        // a sanity check that the flags carry information: at Medium decoys, 64 slots classify most copies right
        expect(right / copies, `churn ${churn}`).toBeGreaterThan(churn === 0 ? 0.85 : 0.7);
      }
    });
  });
});
