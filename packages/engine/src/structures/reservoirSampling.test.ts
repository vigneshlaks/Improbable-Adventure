import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, type StreamParams } from "../enemies/stream";
import { Rng } from "../rng/rng";
import { ReservoirSampling } from "./reservoirSampling";
import type { Answer } from "./types";
import { churnStream, coverageFloor, distinctValues, presenceTargets, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, seed = "reservoir-test") =>
  new ReservoirSampling({ spaceBits, rng: Rng.fromSeed(seed) }, TEST_CONSTANTS);

describe("ReservoirSampling", () => {
  it("costs VALUE_BITS per slot; rejects Space below one slot; is exact until the reservoir fills; and 3 more", () => {
    // costs VALUE_BITS per slot
    {
      const s = make(32 * 10 + 31);
      expect(s.params).toEqual({ slots: 10 });
      expect(s.spaceBits()).toBe(320);
    }
    // rejects Space below one slot
    {
      expect(() => make(31)).toThrow(RangeError);
    }
    // is exact until the reservoir fills
    {
      const s = make(32 * 10);
      for (const v of [1, 1, 2, 3]) s.ingest({ op: "insert", value: v });
      expect(s.query({ kind: "frequency", value: 1 })).toMatchObject({ estimate: 2, low: 2, high: 2 });
      expect(s.query({ kind: "count" })).toMatchObject({ estimate: 3, low: 3, high: 3 });
      expect([...s.values].sort()).toEqual([1, 1, 2, 3]);
    }
    // ignores deletes, leaving ghosts in the sample
    {
      const s = make(32 * 10);
      s.ingest({ op: "insert", value: 9 });
      s.ingest({ op: "delete", value: 9 });
      expect(s.query({ kind: "presence", targets: [9] })?.estimate).toEqual([9]);
    }
    // never exceeds its slot count
    {
      const s = make(32 * 8);
      for (let v = 0; v < 1000; v++) s.ingest({ op: "insert", value: v });
      expect(s.values).toHaveLength(8);
      expect(s.insertsSeen).toBe(1000);
    }
    // is deterministic in its rng and clones independently
    {
      const a = make(32 * 8, "same");
      const b = make(32 * 8, "same");
      for (let v = 0; v < 500; v++) {
        a.ingest({ op: "insert", value: v });
        b.ingest({ op: "insert", value: v });
      }
      expect([...a.values]).toEqual([...b.values]);
      const copy = a.clone();
      for (let v = 500; v < 800; v++) {
        a.ingest({ op: "insert", value: v });
        copy.ingest({ op: "insert", value: v });
      }
      expect([...copy.values]).toEqual([...a.values]); // clone carries the rng position
      const frozen = [...a.values];
      copy.ingest({ op: "insert", value: 99999 });
      expect([...a.values]).toEqual(frozen);
    }
  });

  describe("deletes it cannot see", () => {
    const sampler = (slots: number) => new ReservoirSampling({ spaceBits: 32 * slots, rng: Rng.fromSeed("ghost-sampler") }, TEST_CONSTANTS);

    it("counts the delete events it ignores; widens the Presence low bound by min(deletes seen, targets flagged)", () => {
      // counts the delete events it ignores
      {
        const s = sampler(10);
        s.ingest({ op: "insert", value: 5 });
        s.ingest({ op: "delete", value: 5 });
        s.ingest({ op: "delete", value: 5 });
        expect(s.deletes).toBe(2);
        expect(s.values).toEqual([5]); // the deleted value is still in the sample: a ghost
      }
      // widens the Presence low bound by min(deletes seen, targets flagged)
      {
        const lowAfter = (deletes: number) => {
          const s = sampler(10);
          for (const v of [11, 22, 33]) s.ingest({ op: "insert", value: v });
          for (let i = 0; i < deletes; i++) s.ingest({ op: "delete", value: 11 });
          const answer = s.query({ kind: "presence", targets: [11, 22, 33, 777] });
          expect(answer?.high).toBe(4);
          return answer?.low;
        };
        expect([0, 1, 2, 3, 40].map(lowAfter)).toEqual([3, 2, 1, 0, 0]);
      }
    });

    // Value 7 is inserted 10 times among 20 inserts, then half of all units are deleted (5 of the 7s among them).
    // Everything fits in the sample, so before deletes the answers are exact: 10 sevens and 11 distinct values.
    const halfDeleted = () => {
      const s = sampler(50);
      for (let i = 0; i < 10; i++) s.ingest({ op: "insert", value: 7 });
      for (let v = 100; v < 110; v++) s.ingest({ op: "insert", value: v });
      for (let i = 0; i < 5; i++) s.ingest({ op: "delete", value: 7 });
      for (let v = 100; v < 105; v++) s.ingest({ op: "delete", value: v });
      return s;
    };

    it("is exact before any delete; scales a Frequency estimate to the live share, with a range that allows for the units deleted; bounds the ghosts in a Count by the deleted share, instead of by every delete; and 3 more", () => {
      // is exact before any delete
      {
        const s = sampler(50);
        for (let i = 0; i < 10; i++) s.ingest({ op: "insert", value: 7 });
        for (let v = 100; v < 110; v++) s.ingest({ op: "insert", value: v });
        expect(s.query({ kind: "frequency", value: 7 })).toMatchObject({ estimate: 10, low: 10, high: 10 });
        expect(s.query({ kind: "count" })).toMatchObject({ estimate: 11, low: 11, high: 11 });
      }
      // scales a Frequency estimate to the live share, with a range that allows for the units deleted
      {
        // Half the units are gone, so the estimate halves. Each of the 10 sevens was deleted with chance 1/2, so the
        // survivors are Binomial(10, 1/2): between 2 and 8 with 95 percent confidence.
        expect(halfDeleted().query({ kind: "frequency", value: 7 })).toMatchObject({ estimate: 5, low: 2, high: 8 });
      }
      // bounds the ghosts in a Count by the deleted share, instead of by every delete
      {
        // 11 distinct values ever. Each is a ghost with chance at most 1/2, so at most 8 are (95 percent), leaving at least 3.
        // The estimate expects fewer ghosts: 20 inserts over 11 values is 20/11 units each, so a value is a ghost with
        // chance 0.5 * exp(-(20/11 - 1) * 0.5), about a third, leaving 11 * (1 - 0.332) = 7.35.
        const answer = halfDeleted().query({ kind: "count" });
        expect(answer).toMatchObject({ low: 3, high: 11 });
        expect(answer?.estimate).toBeCloseTo(11 * (1 - 0.5 * Math.exp(-(20 / 11 - 1) * 0.5)), 9);
      }
      // reports nothing live once every unit has been deleted
      {
        const s = sampler(10);
        for (let i = 0; i < 3; i++) s.ingest({ op: "insert", value: 4 });
        for (let i = 0; i < 3; i++) s.ingest({ op: "delete", value: 4 });
        expect(s.query({ kind: "frequency", value: 4 })).toMatchObject({ estimate: 0, low: 0, high: 0 });
      }
      // keeps the estimate inside its range
      {
        for (const answer of [halfDeleted().query({ kind: "frequency", value: 7 }), halfDeleted().query({ kind: "count" })]) {
          expect(answer?.estimate as number).toBeGreaterThanOrEqual(answer?.low as number);
          expect(answer?.estimate as number).toBeLessThanOrEqual(answer?.high as number);
        }
      }
      // carries the delete count through clone
      {
        const s = sampler(10);
        s.ingest({ op: "delete", value: 1 });
        expect(s.clone().deletes).toBe(1);
      }
    });

    // A big sample of a small stream, so most of the stream is in the sample, ghosts included.
    interface Trial {
      contained: boolean;
      ghostsInvolved: boolean;
      /** True when the low bound says something, that is, it is above zero. */
      informative?: boolean;
    }
    const coverage = (label: string, build: (rng: Rng) => Trial, trials = TRIALS) => {
      let held = 0;
      let involved = 0;
      let informative = 0;
      for (let t = 0; t < trials; t++) {
        const result = build(trialRng(label, t));
        if (result.contained) held++;
        if (result.ghostsInvolved) involved++;
        if (result.informative) informative++;
      }
      return { held: held / trials, involved: involved / trials, informative: informative / trials };
    };
    const within = (answer: Answer | null, actual: number) => !!answer && answer.low <= actual && actual <= answer.high;
    const bigSampler = (rng: Rng) => new ReservoirSampling({ spaceBits: 32 * 200, rng: rng.split("sample") }, TEST_CONSTANTS);

    it("keeps its Presence range honest when the enemy deletes values; keeps its Frequency range honest, and still informative, when the enemy deletes values; keeps its Count range honest, and still informative, when the enemy deletes values", () => {
      // keeps its Presence range honest when the enemy deletes values
      {
        const { held, involved } = coverage("res-ghost-presence", (rng) => {
          const { events, live } = churnStream(rng, distinctValues(rng, 60), 400, 0.4);
          const s = bigSampler(rng);
          for (const e of events) s.ingest(e);
          const targets = presenceTargets(live, rng);
          const real = targets.filter((target) => live.count(target) > 0).length;
          const answer = s.query({ kind: "presence", targets }) as Answer;
          return { contained: within(answer, real), ghostsInvolved: (answer.estimate as number[]).some((x) => live.ghosts().includes(x)) };
        });
        expect(involved).toBeGreaterThan(0.5);
        expect(held).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      }
      // keeps its Frequency range honest, and still informative, when the enemy deletes values
      {
        const { held, involved, informative } = coverage("res-ghost-frequency", (rng) => {
          const { events, live } = churnStream(rng, distinctValues(rng, 30), 600, 0.4, { skewed: true });
          const s = bigSampler(rng);
          for (const e of events) s.ingest(e);
          const heaviest = live.mode() as { value: number; count: number };
          const answer = s.query({ kind: "frequency", value: heaviest.value });
          return { contained: within(answer, heaviest.count), ghostsInvolved: events.some((e) => e.op === "delete"), informative: (answer?.low ?? 0) > 0 };
        });
        expect(involved).toBeGreaterThan(0.5);
        expect(held).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
        expect(informative).toBeGreaterThan(0.8); // a low bound of zero would say nothing
      }
      // keeps its Count range honest, and still informative, when the enemy deletes values
      {
        const { held, informative } = coverage("res-ghost-count", (rng) => {
          const { events, live } = churnStream(rng, distinctValues(rng, 60), 400, 0.4);
          const s = bigSampler(rng);
          for (const e of events) s.ingest(e);
          const answer = s.query({ kind: "count" });
          return { contained: within(answer, live.distinct), ghostsInvolved: live.ghosts().length > 0, informative: (answer?.low ?? 0) > 0 };
        });
        expect(held).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
        expect(informative).toBeGreaterThan(0.8);
      }
    });

    // The game's own streams, under the trait mixes that hurt most: deletes, growing bursts, and heavy values that change.
    describe("on the enemy stream generator", () => {
      const TRIALS_PER_MIX = 120;
      const mixes = [];
      for (const universe of [256, 16384]) {
        for (const churn of [0.1, 0.3]) {
          for (const growth of [1, 1.35]) {
            for (const drift of [{ fraction: 0, everyTurns: 0 }, { fraction: 0.5, everyTurns: 3 }]) {
              mixes.push({ universe, churn, growth, drift });
            }
          }
        }
      }

      const cases: Array<readonly [string, () => void]> = [];
      for (const mix of mixes) {
        const name = `${mix.universe} values, churn ${mix.churn}, growth ${mix.growth}, ${mix.drift.everyTurns ? "drifting" : "fixed"} favorites`;
        cases.push([`keeps Frequency and Count ranges honest: ${name}`, () => {
          const params: StreamParams = { ...mix, skew: 0.8, baseBurst: 200 };
          const run = (kind: "frequency" | "count") =>
            coverage(
              `res-stream-${kind}-${name}`,
              (rng) => {
                const seed = `s-${rng.next()}`;
                let stream = createStream(seed);
                const live = new LiveSet();
                const s = new ReservoirSampling({ spaceBits: 32 * 128, rng: rng.split("sample") }, TEST_CONSTANTS);
                for (let turn = 0; turn < 4; turn++) {
                  const burst = nextBurst(params, stream, live);
                  stream = burst.state;
                  for (const e of burst.events) s.ingest(e);
                }
                const heaviest = live.mode() as { value: number; count: number };
                const answer = s.query(kind === "frequency" ? { kind: "frequency", value: heaviest.value } : { kind: "count" });
                const actual = kind === "frequency" ? heaviest.count : live.distinct;
                return { contained: within(answer, actual), ghostsInvolved: live.ghosts().length > 0 };
              },
              TRIALS_PER_MIX,
            ).held;
          const floor = coverageFloor(TEST_CONSTANTS.confidence, TRIALS_PER_MIX);
          expect(run("frequency")).toBeGreaterThanOrEqual(floor);
          expect(run("count")).toBeGreaterThanOrEqual(floor);
        }]);
      }
      it("keeps Frequency and Count ranges honest, under every trait mix", () => eachCase(cases, (run) => run()));
    });
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const slots = 64;
    const space = 32 * slots;

    it("samples uniformly: each stream position is kept with probability slots / N", () => {
      const N = 500;
      const bins = 10;
      const perBin = new Array<number>(bins).fill(0);
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-uniform", t);
        const values = distinctValues(rng, N);
        const position = new Map(values.map((v, i) => [v, i]));
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of values) s.ingest({ op: "insert", value: v });
        for (const v of s.values) {
          const bin = Math.floor(((position.get(v) ?? 0) / N) * bins);
          perBin[bin] = (perBin[bin] ?? 0) + 1;
        }
      }
      const expected = (TRIALS * slots) / bins;
      const chi2 = perBin.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
      // Chi-square test: the sample should look uniform at the 99.9% level.
      expect(chi2).toBeLessThan(27.9);
    });

    it("scales frequency by the sample fraction without bias, and its bounds cover the truth", () => {
      const N = 2000;
      const heavy = 400; // the shielded value occurs 400 times among 2,000 inserts
      let covered = 0;
      let sumEstimate = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-freq", t);
        const [target = 0, ...others] = distinctValues(rng, 1 + (N - heavy));
        const stream = [...new Array<number>(heavy).fill(target), ...others];
        // Fisher-Yates with the trial's own stream.
        for (let i = stream.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
        }
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of stream) s.ingest({ op: "insert", value: v });
        const a = s.query({ kind: "frequency", value: target });
        sumEstimate += a?.estimate as number;
        if (a && a.low <= heavy && heavy <= a.high) covered++;
      }
      expect(Math.abs(sumEstimate / TRIALS / heavy - 1)).toBeLessThan(0.03);
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });

    // Shares near 0% and 100% are where the usual normal approximation breaks down.
    const cases: Array<readonly [string, () => void]> = [];
    for (const heavy of [1960, 1600, 20, 4]) {
      cases.push([`frequency bounds cover the truth when the target is ${heavy} of 2000 inserts`, () => {
        const N = 2000;
        let covered = 0;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`reservoir-extreme-${heavy}`, t);
          const [target = 0, ...others] = distinctValues(rng, 1 + (N - heavy));
          const stream = [...new Array<number>(heavy).fill(target), ...others];
          for (let i = stream.length - 1; i > 0; i--) {
            const j = rng.int(i + 1);
            [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
          }
          const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
          for (const v of stream) s.ingest({ op: "insert", value: v });
          const a = s.query({ kind: "frequency", value: target });
          if (a && a.low <= heavy && heavy <= a.high) covered++;
        }
        expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
      }]);
    }
    it("keeps Frequency bounds honest when the target is nearly all or almost none of the inserts", () => eachCase(cases, (run) => run()));

    it("never reports a zero-width frequency bound from a finite sample", () => {
      const s = new ReservoirSampling({ spaceBits: space, rng: Rng.fromSeed("all-hits") }, TEST_CONSTANTS);
      for (let i = 0; i < 2000; i++) s.ingest({ op: "insert", value: 7 }); // every sampled slot holds 7
      const a = s.query({ kind: "frequency", value: 7 });
      expect(a?.estimate).toBe(2000);
      expect(a?.low).toBeLessThan(2000);
      expect(a?.high).toBe(2000);
    });

    it("keeps the true distinct count inside its GEE ratio bounds", () => {
      const distinct = 500;
      const N = 2000;
      let covered = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("reservoir-distinct", t);
        const values = distinctValues(rng, distinct);
        const stream: number[] = [...values];
        while (stream.length < N) stream.push(values[rng.int(distinct)] ?? 0);
        for (let i = stream.length - 1; i > 0; i--) {
          const j = rng.int(i + 1);
          [stream[i], stream[j]] = [stream[j] ?? 0, stream[i] ?? 0];
        }
        const s = new ReservoirSampling({ spaceBits: space, rng: rng.split("sample") }, TEST_CONSTANTS);
        for (const v of stream) s.ingest({ op: "insert", value: v });
        const a = s.query({ kind: "count" });
        if (a && a.low <= distinct && distinct <= a.high) covered++;
      }
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });
  });
});
