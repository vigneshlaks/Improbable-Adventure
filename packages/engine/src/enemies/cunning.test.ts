import { describe, expect, it } from "vitest";
import { createStructure } from "../structures";
import { HyperLogLog } from "../structures/hyperLogLog";
import { churnStream, distinctValues, TEST_CONSTANTS, trialRng } from "../structures/testUtils";
import type { StructureKind, StructureOptions } from "../structures/types";
import { craftDecoys, craftInserts, publicModel, type AttackContext } from "./cunning";

const SECRET = 0xdeadbeef;
/** Candidate values far from any the streams below use. */
const candidate = (i: number) => (2_000_000_000 + i) >>> 0;

function deployed(kind: StructureKind, options: StructureOptions, values: readonly number[]) {
  const s = createStructure(kind, options, TEST_CONSTANTS);
  for (const value of values) s.ingest({ op: "insert", value });
  return s;
}
const contextFor = (snapshots: AttackContext["snapshots"], coreValue: number | null, budget = 4000): AttackContext => ({ snapshots, constants: TEST_CONSTANTS, coreValue, budget, candidate });

describe("a Cunning enemy's search", () => {
  it("raises a Count-Min Sketch's estimate of the heaviest value several times as far as random values would, and does nothing special to one with a secret seed", () => {
    let crafted = 0;
    let random = 0;
    let seeded = 0;
    const trials = 30;
    for (let t = 0; t < trials; t++) {
      const rng = trialRng("cunning-cms", t);
      const values = distinctValues(rng, 400);
      const { events } = churnStream(rng, values, 1500, 0, { skewed: true });
      const stream = events.map((e) => e.value);
      const core = stream.reduce((best, v) => (stream.filter((x) => x === v).length > stream.filter((x) => x === best).length ? v : best), stream[0] as number);
      const open = deployed("countMinSketch", { spaceBits: 4096 }, stream);
      const secret = deployed("countMinSketch", { spaceBits: 4096, hashSeed: SECRET }, stream);
      const before = open.query({ kind: "frequency", value: core })?.estimate as number;
      const beforeSeeded = secret.query({ kind: "frequency", value: core })?.estimate as number;
      const attackOpen = craftInserts(contextFor([open.snapshot()], core), 60);
      const attackSecret = craftInserts(contextFor([secret.snapshot()], core), 60);
      expect(attackOpen).toHaveLength(60);
      for (const e of attackOpen) open.ingest(e);
      for (const e of attackSecret) secret.ingest(e);
      const plain = deployed("countMinSketch", { spaceBits: 4096 }, stream);
      for (let i = 0; i < 60; i++) plain.ingest({ op: "insert", value: candidate(100000 + i) });
      crafted += (open.query({ kind: "frequency", value: core })?.estimate as number) - before;
      seeded += (secret.query({ kind: "frequency", value: core })?.estimate as number) - beforeSeeded;
      random += (plain.query({ kind: "frequency", value: core })?.estimate as number) - before;
    }
    // 60 random values add about 60 / 32 to the smallest counter; aimed ones, about 60 / 4 (one row's worth each, shared over four rows)
    expect(crafted / trials).toBeGreaterThan(12);
    expect(crafted).toBeGreaterThan(4 * random);
    // for a secret seed the values are no better than random ones (a little worse or better by luck)
    expect(seeded / trials).toBeLessThan(2 * (random / trials) + 2);
  });

  it("fills a LogLog's and a HyperLogLog's registers with rare patterns, inflating the count many times over, and does nothing special to one with a secret seed", () => {
    for (const kind of ["logLog", "hyperLogLog"] as const) {
      const rng = trialRng(`cunning-${kind}`, 0);
      const values = distinctValues(rng, 600);
      const open = deployed(kind, { spaceBits: 1024 }, values);
      const secret = deployed(kind, { spaceBits: 1024, hashSeed: SECRET }, values);
      const m = open.params.registers as number;
      const truth = 600;
      const attackOpen = craftInserts(contextFor([open.snapshot()], null, 20000), m);
      const attackSecret = craftInserts(contextFor([secret.snapshot()], null, 20000), m);
      for (const e of attackOpen) open.ingest(e);
      for (const e of attackSecret) secret.ingest(e);
      const count = (s: typeof open) => s.query({ kind: "count" })?.estimate as number;
      expect(count(open), kind).toBeGreaterThan(4 * truth); // m values add at most m to the truth, and the estimate multiplies
      expect(count(secret), kind).toBeLessThan(1.6 * (truth + m)); // a secret seed turns the same values into ordinary ones
    }
  });

  it("finds values a Bloom Filter flags without ever having seen them, all of them for an open seed and only the filter's own false-positive share for a secret one", () => {
    const rng = trialRng("cunning-bloom", 0);
    const values = distinctValues(rng, 300);
    const open = deployed("bloomFilter", { spaceBits: 2048 }, values);
    const secret = deployed("bloomFilter", { spaceBits: 2048, hashSeed: SECRET }, values);
    const flaggedBy = (s: typeof open, targets: number[]) => ((s.query({ kind: "presence", targets })?.estimate as number[]) ?? []).length;
    const decoysOpen = craftDecoys(contextFor([open.snapshot()], null, 20000), 12);
    const decoysSecret = craftDecoys(contextFor([secret.snapshot()], null, 20000), 12);
    expect(decoysOpen).toHaveLength(12);
    expect(flaggedBy(open, decoysOpen)).toBe(12);
    expect(new Set(decoysOpen).size).toBe(12);
    expect(decoysOpen.every((v) => !values.includes(v))).toBe(true);
    // a secret seed: whatever the enemy finds, the real filter flags only about its own false-positive share
    const fpShare = flaggedBy(secret, Array.from({ length: 2000 }, (_, i) => candidate(500000 + i))) / 2000;
    expect(fpShare).toBeGreaterThan(0); // the filter is full enough for the comparison to mean something
    expect(flaggedBy(secret, decoysSecret) / Math.max(1, decoysSecret.length)).toBeLessThan(Math.min(1, fpShare * 3 + 0.15));
  });

  it("reads the state of a structure and the public hashes only: the same state with another secret seed gives the same values; it looks through at most its budget of candidates; and it has nothing to do against structures it cannot aim at, or with nothing to craft", () => {
    const rng = trialRng("cunning-blind", 0);
    const values = distinctValues(rng, 300);
    const a = deployed("countMinSketch", { spaceBits: 4096 }, values).snapshot();
    const b = { ...a, hashSeed: 1234 };
    const c = { ...a, hashSeed: 987654321 };
    const core = values[0] as number;
    expect(craftInserts(contextFor([b], core), 20)).toEqual(craftInserts(contextFor([c], core), 20));
    expect(craftInserts(contextFor([a], core), 20)).toEqual(craftInserts(contextFor([b], core), 20)); // and equal to the open seed's, since the model is the same
    const h = deployed("hyperLogLog", { spaceBits: 1024 }, values).snapshot();
    expect(craftInserts(contextFor([{ ...h, hashSeed: 5 }], null), 20)).toEqual(craftInserts(contextFor([{ ...h, hashSeed: 6 }], null), 20));
    const f = deployed("bloomFilter", { spaceBits: 2048 }, values).snapshot();
    expect(craftDecoys(contextFor([{ ...f, hashSeed: 5 }], null), 5)).toEqual(craftDecoys(contextFor([{ ...f, hashSeed: 6 }], null), 5));
    // the model has the public seed
    expect(publicModel({ ...h, hashSeed: 5 }, TEST_CONSTANTS)).toBeInstanceOf(HyperLogLog);

    // a budget of candidates
    let asked = 0;
    craftInserts({ ...contextFor([h], null, 777), candidate: (i) => { asked++; return candidate(i); } }, 10);
    expect(asked).toBeLessThanOrEqual(777);
    expect(asked).toBeGreaterThan(0);

    // nothing to aim at: no structures, structures that hash nothing it can use, an empty slot, nothing to craft, no core value for Count-Min
    const exact = deployed("exactMemory", { spaceBits: 4096 }, values).snapshot();
    expect(craftInserts(contextFor([], core), 10)).toEqual([]);
    expect(craftInserts(contextFor([null, exact], core), 10)).toEqual([]);
    expect(craftInserts(contextFor([a], core), 0)).toEqual([]);
    expect(craftInserts(contextFor([a], null), 10)).toEqual([]);
    expect(craftDecoys(contextFor([exact], null), 5)).toEqual([]);
    expect(craftDecoys(contextFor([f], null), 0)).toEqual([]);
  });

  it("shares a limited number of crafted values between the structures it can attack, without repeating one", () => {
    const rng = trialRng("cunning-two", 0);
    const values = distinctValues(rng, 300);
    const cms = deployed("countMinSketch", { spaceBits: 4096 }, values).snapshot();
    const ll = deployed("logLog", { spaceBits: 1024 }, values).snapshot();
    const out = craftInserts(contextFor([cms, ll], values[0] as number, 8000), 30);
    expect(out).toHaveLength(30);
    expect(new Set(out.map((e) => e.value)).size).toBe(30);
    expect(out.every((e) => e.op === "insert")).toBe(true);
    const onlyCms = craftInserts(contextFor([cms], values[0] as number, 8000), 30).map((e) => e.value);
    const onlyLl = craftInserts(contextFor([ll], null, 8000), 30).map((e) => e.value);
    expect(out.some((e) => onlyCms.includes(e.value))).toBe(true);
    expect(out.some((e) => onlyLl.includes(e.value))).toBe(true);
  });

  it("chooses, for the registers, the values with the rarest patterns first, and only values that raise a register; and never repeats a value that two structures both want", () => {
    const rng = trialRng("cunning-registers", 0);
    const values = distinctValues(rng, 600);
    const h = deployed("hyperLogLog", { spaceBits: 1024 }, values);
    const model = publicModel(h.snapshot(), TEST_CONSTANTS) as HyperLogLog;
    // the best value for each register that can be raised, by scanning all candidates
    const best = new Map<number, number>();
    for (let i = 0; i < 4000; i++) {
      const { register, rank, held } = model.probe(candidate(i));
      if (rank > held && rank > (best.get(register) ?? 0)) best.set(register, rank);
    }
    const ranks = [...best.values()].sort((a, b) => b - a);
    expect(ranks.length).toBeGreaterThan(10);
    const few = craftInserts(contextFor([h.snapshot()], null), 5).map((e) => model.probe(e.value).rank);
    expect(few).toEqual(ranks.slice(0, 5)); // the five rarest patterns on offer, best first
    // once those values are in, a second search offers only values that still raise a register
    for (const v of craftInserts(contextFor([h.snapshot()], null), 40)) h.ingest(v);
    const again = publicModel(h.snapshot(), TEST_CONSTANTS) as HyperLogLog;
    const second = craftInserts(contextFor([h.snapshot()], null), 100);
    expect(second.length).toBeGreaterThan(0);
    for (const e of second) {
      const { rank, held } = again.probe(e.value);
      expect(rank).toBeGreaterThan(held);
    }
    // two identical structures want the same values: each is offered once
    const twice = craftInserts(contextFor([h.snapshot(), h.snapshot()], null), 30);
    expect(new Set(twice.map((e) => e.value)).size).toBe(twice.length);
    expect(twice).toHaveLength(30);
  });
});
