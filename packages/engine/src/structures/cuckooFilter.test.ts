import { describe, expect, it } from "vitest";
import { CuckooFilter } from "./cuckooFilter";
import { coverageFloor, distinctValues, TEST_CONSTANTS, TRIALS, trialRng } from "./testUtils";

const make = (spaceBits: number, knob?: number, hashSeed?: number) => new CuckooFilter({ spaceBits, knob, hashSeed }, TEST_CONSTANTS);
const insert = (f: CuckooFilter, v: number) => f.ingest({ op: "insert", value: v });
const flagged = (f: CuckooFilter, targets: number[]) => (f.query({ kind: "presence", targets })?.estimate as number[]).length;

describe("CuckooFilter", () => {
  it("costs buckets x 4 x f bits with f as the knob; flags what was inserted and forgets what was deleted, exactly; pushes fingerprints aside when a bucket is full and drops one only when it cannot place them; answers only Presence; and rejects Space for fewer than two buckets", () => {
    // costs buckets x 4 x f bits, derives the bucket count from Space and f, defaults to 8-bit fingerprints
    {
      const f = make(8192);
      expect(f.params).toEqual({ buckets: 256, bucketSize: 4, fingerprintBits: 8, capacity: 1024 });
      expect(f.spaceBits()).toBe(8192);
      expect(make(8192, 12).params).toMatchObject({ buckets: 170, fingerprintBits: 12 });
      expect(make(8192, 12).spaceBits()).toBeLessThanOrEqual(8192);
    }
    // flags what was inserted, and a delete takes exactly one copy back out
    {
      const f = make(8192);
      for (const v of [11, 22, 33]) insert(f, v);
      expect(flagged(f, [11, 22, 33])).toBe(3);
      f.ingest({ op: "delete", value: 22 });
      expect(f.query({ kind: "presence", targets: [11, 22, 33] })?.estimate).toEqual([11, 33]);
      expect(f.size).toBe(2);
      insert(f, 11); // a second copy of a value is a second fingerprint, so it takes two deletes to forget it
      f.ingest({ op: "delete", value: 11 });
      expect(flagged(f, [11])).toBe(1);
      f.ingest({ op: "delete", value: 11 });
      expect(flagged(f, [11])).toBe(0);
      f.ingest({ op: "delete", value: 999 }); // deleting what is not there changes nothing
      expect(f.size).toBe(1);
    }
    // pushes fingerprints to their other bucket when one is full, so it holds more than a bucket per value pair, and drops one only past what it can place
    {
      const f = make(4 * 4 * 8, 8); // 4 buckets of 4 fingerprints of 8 bits: room for 16
      expect(f.params.capacity).toBe(16);
      const values = distinctValues(trialRng("cuckoo-kick", 0), 16);
      for (const v of values) insert(f, v);
      expect(f.size + f.lost).toBe(16);
      expect(f.size).toBeGreaterThan(8); // more than half of it filled before anything is lost
      for (const v of distinctValues(trialRng("cuckoo-over", 0), 64)) insert(f, v);
      expect(f.size).toBeLessThanOrEqual(16);
      expect(f.lost).toBeGreaterThan(0); // an overfull filter loses fingerprints, and says how many
    }
    // answers only Presence
    {
      const f = make(8192);
      expect(f.query({ kind: "frequency", value: 1 })).toBeNull();
      expect(f.query({ kind: "count" })).toBeNull();
    }
    // too little Space for two buckets, and a fingerprint of a size that cannot be stored
    {
      expect(() => make(40)).toThrow(RangeError);
      expect(() => make(8192, 0)).toThrow(RangeError);
      expect(() => make(8192, 17)).toThrow(RangeError);
    }
  });

  it("snapshots to JSON and back and goes on identically, clones independently, and is replayed exactly: the same inserts make the same table", () => {
    const rng = trialRng("cuckoo-snap", 0);
    const values = distinctValues(rng, 1100); // overfull, so kicks and losses are in the state
    const a = make(8192);
    for (const v of values.slice(0, 700)) insert(a, v);
    const back = CuckooFilter.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(a.snapshot());
    for (const v of values.slice(700)) {
      insert(a, v);
      insert(back, v);
    }
    expect(back.snapshot()).toEqual(a.snapshot()); // restored mid-stream, it carries on the same way
    const copy = a.clone();
    insert(copy, 12345);
    expect(copy.snapshot()).not.toEqual(a.snapshot());
    expect(() => CuckooFilter.fromSnapshot({ ...a.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => CuckooFilter.fromSnapshot({ ...a.snapshot(), state: { ...a.snapshot().state, table: [1, 2] } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  describe(`statistical (${TRIALS} seeded trials)`, () => {
    const space = 8192; // 256 buckets, 1,024 fingerprints at f = 8
    const capacity = 1024;
    const queries = 2000;

    it("never forgets a value while it is at most 90 percent full, and flags decoys at about the rate the load predicts", () => {
      const n = Math.floor(0.9 * capacity);
      let missing = 0;
      let falsePositives = 0;
      let predicted = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("cuckoo-load", t);
        const values = distinctValues(rng, n + queries);
        const f = make(space);
        for (const v of values.slice(0, n)) insert(f, v);
        missing += n - flagged(f, values.slice(0, n));
        falsePositives += flagged(f, values.slice(n));
        predicted += f.falsePositiveRate() * queries;
      }
      expect(missing).toBe(0);
      expect(falsePositives / predicted).toBeGreaterThan(0.85);
      expect(falsePositives / predicted).toBeLessThan(1.15);
      // The theory of the spec: about 8 / 2^f at full load (here 3.1 percent), a little less at 90 percent.
      expect(falsePositives / (TRIALS * queries)).toBeLessThan(8 / 2 ** 8);
    });

    it("keeps its false positives at the rate the fingerprint size gives, whatever the size", () => {
      for (const f of [4, 8, 12]) {
        const buckets = Math.floor(space / (4 * f));
        const n = Math.floor(0.8 * 4 * buckets);
        let falsePositives = 0;
        let total = 0;
        for (let t = 0; t < 40; t++) {
          const rng = trialRng(`cuckoo-bits-${f}`, t);
          const values = distinctValues(rng, n + 4000);
          const filter = make(space, f);
          for (const v of values.slice(0, n)) insert(filter, v);
          falsePositives += flagged(filter, values.slice(n));
          total += 4000;
        }
        const bound = 1 - (1 - 1 / (2 ** f - 1)) ** (2 * 4 * 0.8); // two buckets of four, 80 percent of them taken
        const observed = falsePositives / total;
        expect(Math.abs(observed - bound), `f = ${f}`).toBeLessThan(4 * Math.sqrt((bound * (1 - bound)) / total) + 0.05 * bound);
      }
    });

    it("reports a range that allows for false positives: at 85 percent full, with real and decoy targets mixed, the real count is between low and high at the stated confidence", () => {
      const n = Math.floor(0.85 * capacity);
      let covered = 0;
      let flaggedDecoys = 0;
      let total = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("cuckoo-low", t);
        const values = distinctValues(rng, n + 600);
        const f = make(space);
        for (const v of values.slice(0, n)) insert(f, v);
        for (let c = 0; c < 6; c++) {
          const real = values.slice(c * 6, c * 6 + 6);
          const decoys = values.slice(n + c * 6, n + c * 6 + 6);
          const answer = f.query({ kind: "presence", targets: [...real, ...decoys] });
          flaggedDecoys += (answer?.estimate as number[]).filter((v) => decoys.includes(v)).length;
          if (answer && answer.low <= real.length && real.length <= answer.high) covered++;
          total++;
        }
      }
      expect(flaggedDecoys).toBeGreaterThan(total * 0.1); // decoys really were flagged, so the low bound had work to do
      expect(covered / total).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, total));
    });

    it("allows for deletes of values it never saw (a filter deployed mid-stream): each can take a look-alike's fingerprint and hide a real value, and the upper bound says so", () => {
      let covered = 0;
      let hiddenAny = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("cuckoo-unseen", t);
        const values = distinctValues(rng, 700 + 2500);
        const f = make(space);
        for (const v of values.slice(0, 700)) insert(f, v);
        for (const v of values.slice(700)) f.ingest({ op: "delete", value: v }); // never inserted: the only entries it can remove are look-alikes
        const real = values.slice(0, 12);
        const answer = f.query({ kind: "presence", targets: real });
        if ((answer?.estimate as number[]).length < real.length) hiddenAny++;
        if (answer && answer.low <= real.length && real.length <= answer.high) covered++;
      }
      expect(hiddenAny / TRIALS).toBeGreaterThan(0.3); // real values really were hidden, in a good share of the challenges
      expect(covered / TRIALS).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, TRIALS));
    });

    it("loses values only when overfull, says so, and keeps its range around the truth at the stated confidence even then and with deletes", () => {
      let covered = 0;
      let total = 0;
      let overfullLost = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = trialRng("cuckoo-range", t);
        const values = distinctValues(rng, 1500 + 40);
        const f = make(space);
        const inserted = values.slice(0, 1300); // 127 percent of capacity: it must lose some
        for (const v of inserted) insert(f, v);
        // Delete some of what was inserted, so deletes and losses mix.
        const gone = inserted.slice(0, 200);
        for (const v of gone) f.ingest({ op: "delete", value: v });
        const live = inserted.slice(200);
        overfullLost += f.lost;
        for (let c = 0; c < 6; c++) {
          const real = live.slice(c * 6, c * 6 + 6);
          const decoys = values.slice(1500 + c * 6, 1500 + c * 6 + 6); // never inserted
          const answer = f.query({ kind: "presence", targets: [...real, ...decoys] });
          if (answer && answer.low <= real.length && real.length <= answer.high) covered++;
          total++;
        }
      }
      expect(overfullLost / TRIALS).toBeGreaterThan(10); // overfull filters did lose fingerprints
      expect(covered / total).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, total));
    });
  });
});
