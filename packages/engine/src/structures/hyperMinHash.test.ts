import { describe, expect, it } from "vitest";
import { trueAnswer } from "../combat/challenges";
import { murmur3U32 } from "../hash/murmur3";
import { HyperMinHash } from "./hyperMinHash";
import { MinHash } from "./minHash";
import { churnStream, coverageFloor, distinctValues, likenessChallenge, TEST_CONSTANTS, trialRng } from "./testUtils";
import { DEFAULT_HASH_SEED, type Challenge } from "./types";

const make = (spaceBits: number, hashSeed?: number) => new HyperMinHash({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: { ingest: (e: { op: "insert"; value: number }) => void }, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("HyperMinHash", () => {
  it("has a register for each 8 bits, a power of two of them (four times a MinHash's slots); keeps in a bucket the code of the smallest hash, so a larger code is a smaller hash; sees a copy equal to the stream as the same and a stranger as a collision's chance; counts the values like a HyperLogLog; counts deletes without acting; answers only Likeness; and snapshots, clones", () => {
    // sizes
    {
      const s = make(2048);
      expect(s.params).toEqual({ registers: 256, indexBits: 8, registerBits: 8 });
      expect(s.spaceBits()).toBe(2048);
      expect(make(4096).params.registers).toBe(512);
      expect(make(3000).params.registers).toBe(256); // a power of two that fits
      expect(new MinHash({ spaceBits: 2048 }, TEST_CONSTANTS).params.k).toBe(64);
      expect(() => make(127)).toThrow(RangeError);
    }
    // within a bucket a larger code is a smaller hash (the position of the first one bit, then the mantissa)
    {
      const s = make(2048);
      const values = distinctValues(trialRng("hmh-order", 0), 4000);
      const hashOf = (v: number) => murmur3U32(v, DEFAULT_HASH_SEED);
      const byBucket = new Map<number, Array<{ hash: number; code: number }>>();
      for (const v of values) {
        const regs = s.registersOf([v]);
        const bucket = regs.findIndex((c) => c > 0);
        const list = byBucket.get(bucket) ?? [];
        list.push({ hash: hashOf(v), code: regs[bucket] as number });
        byBucket.set(bucket, list);
      }
      let compared = 0;
      for (const list of byBucket.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i] as { hash: number; code: number };
            const b = list[j] as { hash: number; code: number };
            if (a.code > b.code) expect(a.hash).toBeLessThan(b.hash);
            else if (a.code < b.code) expect(a.hash).toBeGreaterThan(b.hash);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(1000);
    }
    // an equal copy has similarity 1, a stranger about 0, an empty stream 0; the order and repeats of a copy do not matter
    {
      const s = make(4096);
      const values = distinctValues(trialRng("hmh-same", 0), 400);
      feed(s, values);
      const reference = s.registersOf(Array.from({ length: 400 }, (_, i) => 3_500_000_000 + i));
      expect(s.assessCopy(values, reference).similarity).toBeCloseTo(1, 9);
      expect(s.assessCopy([...values].reverse().concat(values.slice(0, 50)), reference).similarity).toBeCloseTo(1, 9);
      expect(s.assessCopy(distinctValues(trialRng("hmh-stranger", 0), 400), reference).similarity).toBeLessThan(0.15);
      expect(make(4096).assessCopy(values, reference).similarity).toBe(0);
    }
    // the count: close to the number of distinct values, with a lower bound below it; zero when empty
    {
      expect(make(2048).distinctEver(0.975)).toEqual({ estimate: 0, low: 0 });
      const s = make(8192);
      feed(s, distinctValues(trialRng("hmh-count", 0), 3000));
      const { estimate, low } = s.distinctEver(0.975);
      expect(Math.abs(estimate - 3000) / 3000).toBeLessThan(4 * 1.04 / Math.sqrt(1024));
      expect(low).toBeLessThan(estimate);
    }
    // a small stream is counted by its empty registers: 100 values in 1,024 registers are well within 10 percent
    {
      const s = make(8192);
      feed(s, distinctValues(trialRng("hmh-small", 0), 100));
      expect(Math.abs(s.distinctEver(0.975).estimate - 100) / 100).toBeLessThan(0.1);
    }
    // the edge of "surely real": an equal copy is surely real when 1 - e - (p + e_p) over 1 - (p + e_p) reaches the threshold, with e the Hoeffding half-width
    // for its share of half the miss chance and e_p the one for the collision rate on the reference (a quarter of it)
    {
      const s = make(4096);
      const values = distinctValues(trialRng("hmh-edge", 0), 400);
      feed(s, values);
      const reference = s.registersOf(Array.from({ length: 400 }, (_, i) => 3_500_000_000 + i));
      const { collision, used } = s.assessCopy(values, reference);
      const eAgree = Math.sqrt(Math.log((2 * 2) / 0.025) / (2 * used));
      const eCollision = Math.sqrt(Math.log(2 / 0.0125) / (2 * used));
      const worst = collision + eCollision;
      const edge = (1 - eAgree - worst) / (1 - worst);
      const at = (threshold: number) => s.query({ kind: "likeness", targets: [0, 1], copies: [values, distinctValues(trialRng("hmh-edge", 1), 400)], threshold });
      expect(collision).toBeGreaterThan(0);
      expect(at(edge - 0.002)).toMatchObject({ estimate: [0], low: 1, high: 1 });
      expect(at(edge + 0.002)).toMatchObject({ estimate: [0], low: 0, high: 1 });
    }
    // deletes are counted and change nothing else
    {
      const s = make(2048);
      feed(s, distinctValues(trialRng("hmh-del", 0), 100));
      const before = JSON.stringify(s.snapshot());
      s.ingest({ op: "delete", value: 5 });
      expect(s.deletes).toBe(1);
      expect(JSON.stringify(s.snapshot()).replace('"deletes":1', '"deletes":0')).toBe(before);
    }
    // only Likeness
    {
      for (const challenge of [{ kind: "presence", targets: [1] }, { kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(make(2048).query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores; a clone is independent; bad ones are refused
    {
      const s = make(2048);
      feed(s, distinctValues(trialRng("hmh-snap", 0), 200));
      const back = HyperMinHash.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      const copy = s.clone();
      feed(copy, [99]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => HyperMinHash.fromSnapshot({ ...s.snapshot(), kind: "minHash" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => HyperMinHash.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, registers: [1] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 200;

    it("estimates a Jaccard similarity with little bias and a spread no worse than a MinHash of four times fewer slots, at several similarities", () => {
      for (const j of [0.2, 0.5, 0.8]) {
        const shared = Math.round((800 * j) / (1 + j));
        const truth = shared / (800 - shared);
        const estimates: number[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`hmh-error-${j}`, t);
          const values = distinctValues(rng, 800 - shared);
          const s = make(4096, rng.next());
          feed(s, values.slice(0, 400));
          const copy = [...values.slice(0, shared), ...values.slice(400)];
          const reference = s.registersOf(Array.from({ length: 400 }, (_, i) => 3_500_000_000 + i));
          estimates.push(s.assessCopy(copy, reference).similarity);
        }
        const mean = estimates.reduce((a, b) => a + b, 0) / TRIALS;
        const sd = Math.sqrt(estimates.reduce((a, b) => a + (b - mean) ** 2, 0) / TRIALS);
        const minHashBound = 1 / (2 * Math.sqrt(128)); // a MinHash of this Space has 128 slots
        expect(sd, `J ${j}`).toBeLessThanOrEqual(minHashBound);
        expect(Math.abs(mean - truth), `J ${j}`).toBeLessThan(0.03);
      }
    });

    it("corrects for registers that agree by chance: unrelated sets of 400 values score about zero, where the share of registers that agree is clearly above it", () => {
      let corrected = 0;
      let raw = 0;
      for (let t = 0; t < 100; t++) {
        const rng = trialRng("hmh-chance", t);
        const values = distinctValues(rng, 800);
        const s = make(4096, rng.next());
        feed(s, values.slice(0, 400));
        const reference = s.registersOf(Array.from({ length: 400 }, (_, i) => 3_500_000_000 + i));
        const result = s.assessCopy(values.slice(400), reference);
        corrected += result.similarity / 100;
        raw += result.agreeShare / 100;
      }
      expect(raw).toBeGreaterThan(0.005); // chance agreements are real: about one register in eighty agrees
      expect(raw).toBeLessThan(0.03);
      // and the estimate takes them out exactly: (agreeing share - chance) / (1 - chance)
      const s = make(4096, 9);
      const values = distinctValues(trialRng("hmh-formula", 0), 600);
      feed(s, values.slice(0, 400));
      const reference = s.registersOf(Array.from({ length: 400 }, (_, i) => 3_500_000_000 + i));
      const half = s.assessCopy([...values.slice(0, 200), ...values.slice(400)], reference);
      expect(half.similarity).toBeCloseTo((half.agreeShare - half.collision) / (1 - half.collision), 12);
      expect(half.similarity).toBeLessThan(half.agreeShare);
      expect(corrected).toBeLessThan(raw);
    });

    it("keeps its surely-real range at the stated confidence, with and without Churn, and classifies more copies right than a MinHash of the same Space at Churn 0", () => {
      for (const churn of [0, 0.1, 0.3]) {
        let covered = 0;
        let asked = 0;
        let right = 0;
        let minRight = 0;
        let copies = 0;
        for (let t = 0; t < 150; t++) {
          const rng = trialRng(`hmh-cover-${churn}`, t);
          const values = distinctValues(rng, 500);
          const { events, live } = churnStream(rng, values, 900, churn);
          const challenge = likenessChallenge(live, rng);
          if (!challenge) continue;
          asked++;
          const hmh = make(2048);
          const min = new MinHash({ spaceBits: 2048 }, TEST_CONSTANTS);
          for (const e of events) {
            hmh.ingest(e);
            min.ingest(e);
          }
          const answer = hmh.query(challenge);
          const flagged = (answer?.estimate ?? []) as number[];
          const minFlagged = (min.query(challenge)?.estimate ?? []) as number[];
          const truth = trueAnswer(challenge, live);
          if (truth.kind !== "likeness" || !answer) throw new Error("expected a likeness answer");
          const hits = flagged.filter((c) => truth.real[c]).length;
          if (answer.low <= hits && hits <= answer.high) covered++;
          for (let c = 0; c < truth.real.length; c++) {
            copies++;
            if (flagged.includes(c) === truth.real[c]) right++;
            if (minFlagged.includes(c) === truth.real[c]) minRight++;
          }
        }
        expect(covered / asked, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, asked));
        if (churn === 0) expect(right / copies).toBeGreaterThan(minRight / copies);
        expect(right / copies, `churn ${churn}`).toBeGreaterThan(churn === 0.3 ? 0.8 : 0.95);
      }
    });
  });
});
