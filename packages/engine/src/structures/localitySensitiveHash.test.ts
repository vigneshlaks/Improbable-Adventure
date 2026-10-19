import { describe, expect, it } from "vitest";
import { trueAnswer } from "../combat/challenges";
import { bandRowsFor, candidateChance, LocalitySensitiveHash } from "./localitySensitiveHash";
import { MinHash } from "./minHash";
import { churnStream, coverageFloor, distinctValues, likenessChallenge, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Challenge } from "./types";

const make = (spaceBits: number, hashSeed?: number) => new LocalitySensitiveHash({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: { ingest: (e: { op: "insert"; value: number }) => void }, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("LocalitySensitiveHash", () => {
  it("chooses the most rows a band can have while a copy at the threshold is still flagged with the recall asked; flags a copy equal to the stream and not a disjoint one; says how many of the flagged are surely real, as the MinHash inside does; answers only Likeness; and snapshots (with the MinHash inside), clones", () => {
    // 1 - (1 - s^r)^b, and the rows
    {
      expect(candidateChance(1, 5, 10)).toBe(1);
      expect(candidateChance(0, 5, 10)).toBe(0);
      expect(candidateChance(0.5, 2, 3)).toBeCloseTo(1 - 0.75 ** 3, 12);
      expect(bandRowsFor(256, 0.6, 0.9)).toBe(5);
      expect(bandRowsFor(64, 0.6, 0.9)).toBe(3);
      expect(bandRowsFor(256, 0.6, 0.99)).toBeLessThan(5); // asking for more recall allows fewer rows
      expect(bandRowsFor(256, 0.9, 0.9)).toBeGreaterThan(5); // a higher threshold tolerates pickier bands
      expect(bandRowsFor(1, 0.6, 0.9)).toBe(1);
      for (const rows of [bandRowsFor(256, 0.6, 0.9)]) expect(candidateChance(0.6, rows, Math.floor(256 / rows))).toBeGreaterThanOrEqual(0.9);
    }
    // sizes as MinHash's; rows depend on the threshold
    {
      const s = make(8192);
      expect(s.params).toEqual({ slots: 256 });
      expect(s.spaceBits()).toBe(8192);
      expect(s.rowsFor(0.6)).toBe(5);
      expect(() => make(255)).toThrow(RangeError);
    }
    // an equal copy is a candidate; a disjoint one, and any copy of an empty stream, is not
    {
      const s = make(4096);
      const values = distinctValues(trialRng("lsh-eq", 0), 300);
      feed(s, values);
      const stranger = distinctValues(trialRng("lsh-eq", 1), 300);
      const challenge: Challenge = { kind: "likeness", targets: [0, 1], copies: [values, stranger], threshold: 0.6 };
      expect(s.query(challenge)).toMatchObject({ estimate: [0], low: 1, high: 1, confidence: 0.95 });
      expect(make(4096).query(challenge)).toMatchObject({ estimate: [], low: 0, high: 0 });
      expect(s.isCandidate(values, 0.6)).toBe(true);
      expect(s.isCandidate([], 0.6)).toBe(false);
      expect(make(4096).isCandidate([], 0.6)).toBe(false); // two empty signatures agree everywhere, and that is nothing
    }
    // the surely-real count is the MinHash's: the same stream gives the same bound
    {
      const s = make(4096);
      const m = new MinHash({ spaceBits: 4096 }, TEST_CONSTANTS);
      const values = distinctValues(trialRng("lsh-same", 0), 300);
      feed(s, values);
      feed(m, values);
      const copies = [values, values.slice(0, 220), values.slice(0, 120)];
      const challenge: Challenge = { kind: "likeness", targets: [0, 1, 2], copies, threshold: 0.6 };
      const assessed = m.assess(challenge as Extract<Challenge, { kind: "likeness" }>);
      const flagged = (s.query(challenge)?.estimate as number[]) ?? [];
      expect(s.query(challenge)?.low).toBe(flagged.filter((t) => assessed[t]?.surelyReal).length);
      expect(flagged).toContain(0);
    }
    // only Likeness
    {
      for (const challenge of [{ kind: "presence", targets: [1] }, { kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(make(4096).query(challenge)).toBeNull();
    }
    // snapshot: JSON, nested MinHash, restores; clone independent; bad ones refused
    {
      const s = make(4096);
      feed(s, distinctValues(trialRng("lsh-snap", 0), 200));
      const json = JSON.parse(JSON.stringify(s.snapshot()));
      expect(json.state.minHash.kind).toBe("minHash");
      const back = LocalitySensitiveHash.fromSnapshot(json, TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      const copy = s.clone();
      feed(copy, [99]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => LocalitySensitiveHash.fromSnapshot({ ...s.snapshot(), kind: "minHash" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => LocalitySensitiveHash.fromSnapshot({ ...s.snapshot(), state: {} }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 300;

    it("flags a copy of a given similarity with the chance 1 - (1 - s^r)^b the banding gives (within four standard errors), at similarities from 0.3 to 0.8, and so misses a real copy almost never", () => {
      const slots = 128;
      const rows = bandRowsFor(slots, 0.6, TEST_CONSTANTS.lshRecall);
      const bands = Math.floor(slots / rows);
      for (const s of [0.3, 0.5, 0.6, 0.7, 0.8]) {
        // two sets of 300 values sharing x of them: J = x / (600 - x)
        const shared = Math.round((600 * s) / (1 + s));
        const truth = shared / (600 - shared);
        let flagged = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`lsh-chance-${s}`, t);
          const values = distinctValues(rng, 600 - shared);
          const sketch = make(slots * 32, rng.next());
          feed(sketch, values.slice(0, 300));
          if (sketch.isCandidate([...values.slice(0, shared), ...values.slice(300)], 0.6)) flagged++;
        }
        const chance = candidateChance(truth, rows, bands);
        const sigma = Math.sqrt((chance * (1 - chance)) / TRIALS);
        expect(Math.abs(flagged / TRIALS - chance), `similarity ${s}`).toBeLessThan(4 * sigma + 0.01);
        if (s >= 0.7) expect(flagged / TRIALS, `similarity ${s}`).toBeGreaterThan(0.95);
      }
    });

    it("misses at most a few real copies on the challenges the game builds, flags many more decoys than MinHash does, and keeps its surely-real range at the stated confidence, with Churn", () => {
      for (const churn of [0, 0.2]) {
        let missed = 0;
        let real = 0;
        let lshDecoys = 0;
        let minDecoys = 0;
        let covered = 0;
        let asked = 0;
        for (let t = 0; t < 120; t++) {
          const rng = trialRng(`lsh-game-${churn}`, t);
          const values = distinctValues(rng, 500);
          const { events, live } = churnStream(rng, values, 900, churn);
          const challenge = likenessChallenge(live, rng);
          if (!challenge) continue;
          asked++;
          const lsh = make(4096);
          const min = new MinHash({ spaceBits: 4096 }, TEST_CONSTANTS);
          for (const e of events) {
            lsh.ingest(e);
            min.ingest(e);
          }
          const answer = lsh.query(challenge);
          const flagged = (answer?.estimate ?? []) as number[];
          const minFlagged = (min.query(challenge)?.estimate ?? []) as number[];
          const truth = trueAnswer(challenge, live);
          if (truth.kind !== "likeness" || !answer) throw new Error("expected a likeness answer");
          for (let c = 0; c < truth.real.length; c++) {
            if (truth.real[c]) {
              real++;
              if (!flagged.includes(c)) missed++;
            } else {
              if (flagged.includes(c)) lshDecoys++;
              if (minFlagged.includes(c)) minDecoys++;
            }
          }
          const hits = flagged.filter((c) => truth.real[c]).length;
          if (answer.low <= hits && hits <= answer.high) covered++;
        }
        if (churn === 0) expect(missed / real, "no Churn").toBeLessThan(0.05);
        expect(lshDecoys, `churn ${churn}`).toBeGreaterThan(minDecoys);
        expect(covered / asked, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, asked));
      }
    });
  });
});
