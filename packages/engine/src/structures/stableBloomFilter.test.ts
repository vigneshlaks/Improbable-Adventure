import { describe, expect, it } from "vitest";
import { BloomFilter } from "./bloomFilter";
import { forgetProbability, stableDecrements, StableBloomFilter } from "./stableBloomFilter";
import { createStructure, restoreStructure } from "./index";
import type { Answer } from "./types";
import { binomialUpper } from "../stats/stats";
import { churnStream, coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

// A Stable Bloom Filter is a Bloom Filter with the Fading enchantment: 3-bit counters instead of bits. Each insert first
// decrements a few random cells, then sets the value's cells to the maximum. Old information fades, so the filter never
// fills up, at the price of false negatives: a value inserted long enough ago is forgotten.

const fading = (spaceBits: number, knob?: number, hashSeed = 1) => new StableBloomFilter({ spaceBits, knob, hashSeed, enchantment: "fading" }, TEST_CONSTANTS);

describe("StableBloomFilter", () => {
  it("builds 3-bit cells from Space, derives the hash count and the decay rate from the expected items, and is built by the factory", () => {
    const s = fading(3000, 100);
    expect(s.params).toMatchObject({ cells: 1000, k: 7, expectedItems: 100, cellMax: 7 });
    expect(s.spaceBits()).toBe(3000);
    expect(fading(8192).params.cells).toBe(2730);
    // With no knob it remembers about 1.5 times as many values as it has cells (measured best on Elite and Boss sized streams).
    expect(fading(8192).params.expectedItems).toBe(4095);
    expect(fading(3000).params.expectedItems).toBe(1500);
    expect(() => fading(30)).toThrow(RangeError);
    expect(() => new StableBloomFilter({ spaceBits: 3000 }, TEST_CONSTANTS)).not.toThrow(); // the class is the fading variant whatever the option says
    // The factory builds it only for the Fading enchantment, and a plain Bloom Filter otherwise.
    expect(createStructure("bloomFilter", { spaceBits: 3000, enchantment: "fading" }, TEST_CONSTANTS)).toBeInstanceOf(StableBloomFilter);
    expect(createStructure("bloomFilter", { spaceBits: 3000 }, TEST_CONSTANTS)).toBeInstanceOf(BloomFilter);
    expect(createStructure("bloomFilter", { spaceBits: 3000, enchantment: "seeded" }, TEST_CONSTANTS)).toBeInstanceOf(BloomFilter);
    // The paper's rate: Z = e^(-k n / m) = 0.7408, P = 1 / ((Z^(-1/Max) - 1)(1/k - 1/m)) = 28.6 for m = 1000, k = 3, n = 100, Max = 3.
    expect(stableDecrements(1000, 3, 100, 3)).toBe(29);
    expect(stableDecrements(1000, 3, 1, 3)).toBe(1000); // almost nothing expected: everything clears at once, capped at the cell count
    expect(stableDecrements(1000, 3, 100000, 3)).toBe(1); // a flood: never less than one
    expect(stableDecrements(20, 3, 5, 3)).toBe(12); // the 1/cells term matters in a small filter: 12.4, against 10.6 without it
  });

  it("flags what was just inserted, forgets it after enough later inserts, counts deletes without acting on them, and answers only Presence", () => {
    const s = fading(3000, 100);
    const values = distinctValues(trialRng("sbf-unit", 0), 3000);
    s.ingest({ op: "insert", value: values[0]! });
    const flagged = (value: number) => (s.query({ kind: "presence", targets: [value] })?.estimate as number[]).length === 1;
    expect(flagged(values[0]!)).toBe(true);
    s.ingest({ op: "delete", value: values[0]! });
    expect(flagged(values[0]!)).toBe(true); // a delete cannot clear it (a ghost), but it is counted
    expect(s.deletes).toBe(1);
    for (const value of values.slice(1, 2000)) s.ingest({ op: "insert", value });
    expect(flagged(values[0]!)).toBe(false); // 2,000 later inserts: a window of about 100 items has long passed
    expect(s.inserts).toBe(2000);
    // With the default window a value survives a whole turn's worth of later inserts (200 of them), almost always.
    let remembered = 0;
    for (let t = 0; t < 300; t++) {
      const [marker, ...others] = distinctValues(trialRng("sbf-default-window", t), 201);
      const roomy = fading(3000, undefined, t + 1);
      roomy.ingest({ op: "insert", value: marker! });
      for (const value of others) roomy.ingest({ op: "insert", value });
      if ((roomy.query({ kind: "presence", targets: [marker!] })?.estimate as number[]).length === 1) remembered++;
    }
    expect(remembered / 300).toBeGreaterThan(0.98);
    // Deleted values can still be flagged, so the low bound allows for them: 5 flagged, 2 deleted, no collisions to speak of.
    const ghosty = fading(30000, 100);
    const five = distinctValues(trialRng("sbf-ghosts", 0), 5);
    for (const value of five) ghosty.ingest({ op: "insert", value });
    ghosty.ingest({ op: "delete", value: five[0]! });
    ghosty.ingest({ op: "delete", value: five[1]! });
    const ghostAnswer = ghosty.query({ kind: "presence", targets: five }) as Answer;
    expect([(ghostAnswer.estimate as number[]).length, ghostAnswer.low, ghostAnswer.high]).toEqual([5, 3, 5]);
    expect(s.query({ kind: "frequency", value: 1 })).toBeNull();
    expect(s.query({ kind: "count" })).toBeNull();

    // Clones are independent; merging takes the larger counter of each cell; the snapshot survives JSON and restores a working filter.
    const copy = s.clone();
    copy.ingest({ op: "insert", value: values[2500]! });
    expect(s.inserts).toBe(2000);
    expect(copy.inserts).toBe(2001);
    const merged = s.merge(copy);
    expect(merged.inserts).toBe(4001);
    // Merging takes the larger counter, so a value kept fresh in either filter stays flagged in the merge.
    const left = fading(30000, 100);
    const right = fading(30000, 100);
    left.ingest({ op: "insert", value: values[10]! });
    right.ingest({ op: "insert", value: values[11]! });
    expect((left.merge(right).query({ kind: "presence", targets: [values[10]!, values[11]!] })?.estimate as number[]).length).toBe(2);
    expect(() => left.merge(fading(15000, 100))).toThrow();
    const revived = restoreStructure(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
    expect(revived).toBeInstanceOf(StableBloomFilter);
    expect(revived.snapshot()).toStrictEqual(s.snapshot());
    expect((revived as StableBloomFilter).fill).toBe(s.fill); // the share of non-zero cells is rebuilt, not lost
    expect(s.snapshot().enchantment).toBe("fading");
    const probe = { kind: "presence" as const, targets: values.slice(1500, 1520) };
    for (const event of values.slice(2600, 2700).map((value) => ({ op: "insert" as const, value }))) {
      s.ingest(event);
      revived.ingest(event);
    }
    expect(revived.query(probe)).toEqual(s.query(probe)); // the decay is a function of the state, so it continues identically
  });

  it("holds a stable fullness and false-positive rate on a stream far longer than it was built for, where a plain Bloom Filter saturates", () => {
    const cells = 3000;
    const n = 100;
    const design = Math.exp((-7 * 100) / 1000); // Z for m = 1000 cells (3,000 bits), k = 7, n = 100
    let zeros = 0;
    let falsePositives = 0;
    let probes = 0;
    let plainFalsePositives = 0;
    const runs = 20;
    for (let t = 0; t < runs; t++) {
      const rng = trialRng("sbf-stable", t);
      const values = distinctValues(rng, 20 * n + 400);
      const s = fading(cells, n, t + 1);
      const plain = new BloomFilter({ spaceBits: cells, knob: n, hashSeed: t + 1 }, TEST_CONSTANTS);
      for (const value of values.slice(0, 20 * n)) {
        s.ingest({ op: "insert", value });
        plain.ingest({ op: "insert", value });
      }
      const fresh = values.slice(20 * n);
      falsePositives += (s.query({ kind: "presence", targets: fresh })?.estimate as number[]).length;
      plainFalsePositives += (plain.query({ kind: "presence", targets: fresh })?.estimate as number[]).length;
      probes += fresh.length;
      zeros += 1 - s.fill;
    }
    expect(zeros / runs).toBeGreaterThan(design - 0.04);
    expect(zeros / runs).toBeLessThan(design + 0.04);
    const theory = (1 - design) ** 7;
    const sigma = Math.sqrt((theory * (1 - theory)) / probes);
    expect(Math.abs(falsePositives / probes - theory)).toBeLessThan(4 * sigma + 0.05 * theory + 0.01);
    expect(plainFalsePositives / probes).toBeGreaterThan(0.9); // 2,000 values in 3,000 bits: the plain filter flags nearly everything
  });

  it("forgets a value at the rate the structure bounds it by, which grows with age and is zero for a value just inserted", () => {
    const n = 100;
    const cells = 3000;
    const m = 1000;
    const k = 7;
    const P = stableDecrements(m, k, n, 7);
    const trials = 600;
    const rates: number[] = [];
    for (const age of [0, 50, 100, 200, 400]) {
      let missed = 0;
      for (let t = 0; t < trials; t++) {
        const rng = trialRng(`sbf-age-${age}`, t);
        const [marker, ...others] = distinctValues(rng, 1 + age);
        const s = fading(cells, n, t + 1);
        s.ingest({ op: "insert", value: marker! });
        for (const value of others) s.ingest({ op: "insert", value });
        if ((s.query({ kind: "presence", targets: [marker!] })?.estimate as number[]).length === 0) missed++;
      }
      const observed = missed / trials;
      rates.push(observed);
      const bound = forgetProbability(age, P, m, 7, k);
      expect(observed).toBeLessThanOrEqual(bound + 4 * Math.sqrt((bound * (1 - bound)) / trials) + 0.01);
    }
    expect(rates[0]).toBe(0); // inserted just now
    expect(rates[4]!).toBeGreaterThan(rates[1]! + 0.1); // forgetting grows with age
    expect(forgetProbability(0, P, m, 7, k)).toBe(0);
    // Any one of the k cells decaying forgets the value: with k = 1 the bound is the single-cell chance, with more cells it is larger.
    expect(forgetProbability(50, P, m, 7, 7)).toBeGreaterThan(3 * forgetProbability(50, P, m, 7, 1));
    expect(forgetProbability(100000, P, m, 7, k)).toBeGreaterThan(0.99);
  });

  it(`gives a Presence range that holds the truth at the stated confidence, widens upward once values can have been forgotten, and keeps ghosts from lingering (${TRIALS / 5} seeded trials)`, () => {
    const trials = TRIALS / 5;
    let covered = 0;
    let oldWiden = 0;
    for (let t = 0; t < trials; t++) {
      const rng = trialRng("sbf-range", t);
      const universe = distinctValues(rng, 150);
      const { events, live } = churnStream(rng, universe, 700, 0.2);
      const s = fading(3000, 100, t + 1);
      for (const event of events) s.ingest(event);
      const real = universe.filter((value) => live.count(value) > 0);
      const targets = [...real.slice(0, 6), ...distinctValues(trialRng("sbf-decoys", t), 6).map((v) => v + 1_000_000_000)];
      const truth = targets.filter((target) => live.count(target) > 0).length;
      const answer = s.query({ kind: "presence", targets }) as Answer;
      if (answer.low <= truth && truth <= answer.high) covered++;
      // The two sides of the range share the chance of a miss, so each is taken at 97.5 percent.
      const flaggedCount = (answer.estimate as number[]).length;
      const falseBound = binomialUpper(targets.length, s.fill ** (s.params.k as number), 1 - (1 - TEST_CONSTANTS.confidence) / 2);
      expect(answer.low).toBe(Math.max(0, flaggedCount - falseBound - Math.min(s.deletes, flaggedCount)));
      if (answer.high > (answer.estimate as number[]).length) oldWiden++;
    }
    expect(covered / trials).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, trials));
    expect(oldWiden / trials).toBeGreaterThan(0.9); // 700 inserts against a window of 100: forgetting is possible for nearly any target

    const young = fading(3000, 100);
    for (const value of distinctValues(trialRng("sbf-young", 0), 5)) young.ingest({ op: "insert", value });
    const youngAnswer = young.query({ kind: "presence", targets: [1, 2, 3] }) as Answer;
    expect(youngAnswer.high).toBe((youngAnswer.estimate as number[]).length); // five inserts ago cannot have faded

    // In between, the high bound adds the most that can have been forgotten, taken at 97.5 percent like the low side.
    // 3 real targets among 12, 52 inserts in all: the chance of having forgotten a value is 0.37, whose 97.5 and 95 percent quantiles
    // (8 and 7 of 12) differ, and flagged + 8 stays under the 12 targets, so the cap does not hide it.
    const mid = fading(3000, 100);
    const real = distinctValues(trialRng("sbf-mid", 0), 3);
    for (const value of [...real, ...distinctValues(trialRng("sbf-mid-more", 0), 49)]) mid.ingest({ op: "insert", value });
    const targets = [...real, ...distinctValues(trialRng("sbf-mid-decoys", 0), 9).map((value) => value + 1_500_000_000)];
    const midAnswer = mid.query({ kind: "presence", targets }) as Answer;
    const { cells, k, decrements, cellMax } = mid.params as Record<string, number>;
    const forgotten = forgetProbability(52, decrements!, cells!, cellMax!, k!);
    expect(forgotten).toBeCloseTo(0.37, 2);
    const missed = binomialUpper(12, forgotten, 1 - (1 - TEST_CONSTANTS.confidence) / 2);
    expect(missed).toBe(8);
    expect(midAnswer.high).toBe((midAnswer.estimate as number[]).length + missed);
  });
});
