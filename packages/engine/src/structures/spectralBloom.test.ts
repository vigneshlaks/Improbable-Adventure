import { describe, expect, it } from "vitest";
import { SpectralBloom } from "./spectralBloom";
import { churnStream, coverageFloor, distinctValues, presenceTargets, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Challenge } from "./types";

const make = (spaceBits: number, knob?: number, hashSeed?: number) => new SpectralBloom({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);
const insert = (s: SpectralBloom, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("SpectralBloom", () => {
  it("costs 16 bits per counter; takes the hash count from the expected items as a Bloom filter does; counts a value in k counters and never undercounts it; flags a value present only when every counter of it is above zero; takes deletes back exactly; stops a counter at its largest and then says so; answers Presence and Frequency only; and snapshots, clones", () => {
    // sized in counters; k from the knob; two ways to ask the same sizes
    {
      const s = make(4096, 100);
      expect(s.params).toMatchObject({ counters: 256, expectedItems: 100 });
      expect(s.params.k).toBe(Math.max(1, Math.round((256 / 100) * Math.LN2)));
      expect(s.spaceBits()).toBe(4096);
      expect(make(4100).spaceBits()).toBe(4096);
      expect(() => make(255)).toThrow(RangeError);
    }
    // a value counted three times reads as three; one never seen reads zero in an empty filter
    {
      const s = make(8192);
      insert(s, [7, 7, 7, 9]);
      expect(s.estimate(7)).toBe(3);
      expect(s.estimate(9)).toBe(1);
      expect(s.estimate(123456)).toBe(0);
      expect(s.query({ kind: "frequency", value: 7 })).toMatchObject({ estimate: 3, high: 3 });
    }
    // presence: values inserted are flagged; one never inserted is not, in a sparse filter
    {
      const s = make(8192);
      insert(s, [10, 20, 30]);
      expect(s.query({ kind: "presence", targets: [10, 20, 30, 40, 50] })).toMatchObject({ estimate: [10, 20, 30], high: 3 });
      // present means every counter is above zero, which is just when the smallest is: in a fuller filter a value can share some counters and still be absent
      const fuller = make(2048, 60);
      insert(fuller, distinctValues(trialRng("spectral-partial", 0), 40));
      const probes = Array.from({ length: 3000 }, (_, i) => 3_000_000_000 + i);
      const flaggedProbes = new Set(fuller.query({ kind: "presence", targets: probes })?.estimate as number[]);
      expect(flaggedProbes.size).toBeGreaterThan(0);
      expect(flaggedProbes.size).toBeLessThan(probes.length / 2);
      for (const probe of probes) expect(flaggedProbes.has(probe)).toBe(fuller.estimate(probe) > 0);
    }
    // deletes take the counters back: insert then delete returns the filter to empty, and a delete of a value never seen does not go below zero
    {
      const s = make(8192);
      const before = JSON.stringify(s.snapshot());
      insert(s, [5, 5, 6]);
      for (const value of [5, 5, 6]) s.ingest({ op: "delete", value });
      expect(JSON.stringify(s.snapshot())).toBe(before);
      s.ingest({ op: "delete", value: 99 });
      expect(s.liveTotal).toBe(0);
      expect(s.estimate(99)).toBe(0);
      expect(s.query({ kind: "presence", targets: [5] })).toMatchObject({ estimate: [] });
    }
    // a counter that stopped says "at least": no upper bound, and a delete leaves it alone
    {
      const narrow = new SpectralBloom({ spaceBits: 64 * 4 }, { ...TEST_CONSTANTS, spectralCounterBits: 4 });
      insert(narrow, Array.from({ length: 40 }, () => 1));
      expect(narrow.estimate(1)).toBe(15);
      expect(narrow.query({ kind: "frequency", value: 1 })?.high).toBe(Number.POSITIVE_INFINITY);
      narrow.ingest({ op: "delete", value: 1 });
      expect(narrow.estimate(1)).toBe(15);
    }
    // only these two questions
    {
      for (const challenge of [{ kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(make(4096).query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores; a clone is independent; a bad one is refused
    {
      const s = make(4096);
      insert(s, distinctValues(trialRng("spectral-snap", 0), 100));
      const back = SpectralBloom.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      const copy = s.clone();
      insert(copy, [424242]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => SpectralBloom.fromSnapshot({ ...s.snapshot(), kind: "countMinSketch" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => SpectralBloom.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, counters: [1] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 300;

    it("never undercounts a value, with or without deletes, and its overshoot stays inside the band at the stated confidence (1 - e^-k), for the heaviest value of skewed and flat streams", () => {
      for (const churn of [0, 0.2]) {
        for (const skewed of [false, true]) {
          let covered = 0;
          for (let t = 0; t < TRIALS; t++) {
            const rng = trialRng(`spectral-count-${churn}-${skewed}`, t);
            const values = distinctValues(rng, 400);
            const { events, live } = churnStream(rng, values, 1500, churn, { skewed });
            const s = make(8192);
            for (const e of events) s.ingest(e);
            const mode = live.mode();
            if (!mode) continue;
            const estimate = s.estimate(mode.value);
            expect(estimate, `churn ${churn} skewed ${skewed}`).toBeGreaterThanOrEqual(mode.count);
            const answer = s.query({ kind: "frequency", value: mode.value });
            if (answer && answer.low <= mode.count && estimate - mode.count <= s.errorBand) covered++;
          }
          expect(covered / TRIALS, `churn ${churn} skewed ${skewed}`).toBeGreaterThanOrEqual(coverageFloor(1 - Math.exp(-make(8192).params.k!), TRIALS));
        }
      }
    });

    it("has no false negatives and a false-positive rate no more than 1.3 times the one it reports (plus noise), and a Presence range that holds the real flagged targets at the stated confidence", () => {
      let observed = 0;
      let reported = 0;
      let covered = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("spectral-presence", t);
        const values = distinctValues(rng, 700);
        const { events, live } = churnStream(rng, values, 900, 0.1);
        const s = make(8192);
        for (const e of events) s.ingest(e);
        for (const value of live.liveValues()) expect(s.query({ kind: "presence", targets: [value] })?.estimate).toEqual([value]);
        const probes = Array.from({ length: 300 }, (_, i) => 3_000_000_000 + t * 1000 + i);
        observed += (s.query({ kind: "presence", targets: probes })?.estimate as number[]).length / probes.length;
        reported += s.falsePositiveRate;
        const targets = presenceTargets(live, rng);
        const answer = s.query({ kind: "presence", targets });
        const real = (answer?.estimate as number[]).filter((v) => live.count(v) > 0).length;
        if (answer && answer.low <= real && real <= answer.high) covered++;
      }
      expect(observed / TRIALS).toBeLessThanOrEqual((reported / TRIALS) * 1.3 + 0.002);
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });
  });
});
