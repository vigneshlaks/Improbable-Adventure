import { describe, expect, it } from "vitest";
import { BloomFilter } from "./bloomFilter";
import { layerTarget, ScalableBloom } from "./scalableBloom";
import { churnStream, coverageFloor, distinctValues, presenceTargets, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Challenge } from "./types";

const make = (spaceBits: number, hashSeed?: number) => new ScalableBloom({ spaceBits, hashSeed }, TEST_CONSTANTS);
const feed = (s: ScalableBloom, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));
const flagged = (s: ScalableBloom, targets: number[]) => (s.query({ kind: "presence", targets })?.estimate as number[]).length;

describe("ScalableBloom", () => {
  it("has a first layer of a share of the Space and the rest in reserve; adds a larger, tighter layer when one fills, drawing on the reserve and never beyond the Space; never misses a value it took in; does not spend capacity on a value it already reports; counts deletes without acting; answers only Presence; and snapshots, clones", () => {
    // layers: the first takes the share, targets tighten by the factor, the reserve holds the rest
    {
      const s = make(4096);
      expect(s.params.firstLayerBits).toBe(1024);
      expect(s.layerCount).toBe(1);
      expect(s.reserveBits).toBe(3072);
      expect(s.spaceBits()).toBe(4096);
      expect(layerTarget(TEST_CONSTANTS, 0)).toBeCloseTo(0.005, 12);
      expect(layerTarget(TEST_CONSTANTS, 2)).toBeCloseTo(0.00125, 12);
      expect(() => make(255)).toThrow(RangeError);
    }
    // layers appear when one holds as many items as it was sized for, each twice the last until the reserve is spent
    {
      const s = make(4096);
      const values = distinctValues(trialRng("scalable-layers", 0), 1200);
      const first = s.params.firstLayerItems as number;
      feed(s, values.slice(0, first));
      expect(s.layerCount).toBe(1);
      feed(s, values.slice(first, first + 1));
      expect(s.layerCount).toBe(2);
      expect(s.reserveBits).toBe(3072 - 2048); // the second layer is twice the first
      feed(s, values);
      expect(s.layerCount).toBeGreaterThanOrEqual(3);
      expect(s.reserveBits).toBeGreaterThanOrEqual(0);
      expect(s.reserveBits).toBeLessThan(64); // the reserve is used up, and not overdrawn
      const bits = (JSON.parse(JSON.stringify(s.snapshot())).state.layers as Array<{ spaceBits: number }>).reduce((sum, layer) => sum + layer.spaceBits, 0);
      expect(bits).toBeLessThanOrEqual(4096);
    }
    // no false negatives, whatever the layer, and a value already reported takes no capacity
    {
      const s = make(4096);
      const values = distinctValues(trialRng("scalable-members", 0), 500);
      feed(s, values);
      expect(flagged(s, values)).toBe(values.length);
      const layers = s.layerCount;
      feed(s, values);
      feed(s, values);
      expect(s.layerCount).toBe(layers);
      expect(s.inserts).toBe(1500);
      // repeats of a few values never fill a layer
      const few = make(4096);
      for (let rep = 0; rep < 40; rep++) feed(few, values.slice(0, 20));
      expect(few.layerCount).toBe(1);
    }
    // deletes are counted and change nothing else; only Presence is answered
    {
      const s = make(4096);
      const values = distinctValues(trialRng("scalable-deletes", 0), 50);
      feed(s, values);
      const before = JSON.stringify(s.snapshot());
      s.ingest({ op: "delete", value: values[0] as number });
      expect(s.deletes).toBe(1);
      expect(flagged(s, [values[0] as number])).toBe(1); // it is a ghost now
      expect(JSON.stringify(s.snapshot()).replace(/"deletes":1/, '"deletes":0')).toBe(before);
      for (const challenge of [{ kind: "frequency", value: 1 }, { kind: "count" }, { kind: "rank", quantile: 0.5 }] as Challenge[]) expect(s.query(challenge)).toBeNull();
    }
    // a snapshot is JSON and restores to the same answers and keeps growing the same way; a clone is independent; a bad snapshot is refused
    {
      const s = make(4096);
      const values = distinctValues(trialRng("scalable-snap", 0), 900);
      feed(s, values.slice(0, 450));
      const back = ScalableBloom.fromSnapshot(JSON.parse(JSON.stringify(s.snapshot())), TEST_CONSTANTS);
      expect(back.snapshot()).toEqual(s.snapshot());
      feed(s, values.slice(450));
      feed(back, values.slice(450));
      expect(back.snapshot()).toEqual(s.snapshot());
      const copy = s.clone();
      feed(copy, [123456789]);
      expect(copy.snapshot()).not.toEqual(s.snapshot());
      expect(() => ScalableBloom.fromSnapshot({ ...s.snapshot(), kind: "bloomFilter" }, TEST_CONSTANTS)).toThrow(RangeError);
      expect(() => ScalableBloom.fromSnapshot({ ...s.snapshot(), state: { ...s.snapshot().state, layers: [] } }, TEST_CONSTANTS)).toThrow(RangeError);
    }
  });

  describe("statistical", () => {
    const TRIALS = 200;

    it("keeps the false-positive rate it reports honest at 0.6, 1.3, 2.6, 3.5 and 5 times what the first layer was sized for (observed no more than 1.3 times the reported rate, plus a probe's sampling noise), and beats a plain Bloom filter of the same Space sized for the first guess once the stream is well past it (a plain filter sized right for the stream is better: this is a hedge for an unknown size)", () => {
      for (const items of [60, 120, 240, 330, 480]) {
        let observed = 0;
        let reported = 0;
        let plain = 0;
        const probes = 400;
        for (let t = 0; t < TRIALS; t++) {
          const rng = trialRng(`scalable-fp-${items}`, t);
          const values = distinctValues(rng, items + probes);
          const s = make(4096);
          const b = new BloomFilter({ spaceBits: 4096, knob: s.params.firstLayerItems }, TEST_CONSTANTS); // sized for the first guess, as a player who expects no growth would
          for (const value of values.slice(0, items)) {
            s.ingest({ op: "insert", value });
            b.ingest({ op: "insert", value });
          }
          const outside = values.slice(items);
          observed += flagged(s, outside) / probes;
          plain += outside.filter((v) => b.has(v)).length / probes;
          reported += s.falsePositiveRate();
        }
        expect(observed / TRIALS, `${items} items`).toBeLessThanOrEqual((reported / TRIALS) * 1.3 + 0.002);
        expect(observed / TRIALS, `${items} items`).toBeGreaterThan((reported / TRIALS) * 0.5 - 0.002); // and the report is not far above what happens
        if (items >= 330) expect(observed, `${items} items`).toBeLessThan(plain); // past the first guess the plain filter is saturating and the stack has grown
      }
    });

    it("gives a Presence range that holds the number of real flagged targets at the stated confidence, under growth and Churn", () => {
      for (const churn of [0, 0.2]) {
        let covered = 0;
        for (let t = 0; t < 500; t++) {
          const rng = trialRng(`scalable-cover-${churn}`, t);
          const values = distinctValues(rng, 700);
          const { events, live } = churnStream(rng, values, 900, churn);
          const s = make(4096);
          for (const e of events) s.ingest(e);
          const targets = presenceTargets(live, rng);
          const answer = s.query({ kind: "presence", targets });
          const real = (answer?.estimate as number[]).filter((v) => live.count(v) > 0).length;
          if (answer && answer.low <= real && real <= answer.high) covered++;
        }
        expect(covered / 500, `churn ${churn}`).toBeGreaterThanOrEqual(coverageFloor(TEST_CONSTANTS.confidence, 500));
      }
    });
  });
});
