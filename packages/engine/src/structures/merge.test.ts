import { describe, expect, it } from "vitest";
import { KllSketch } from "./kllSketch";
import { MinHash } from "./minHash";
import { TDigest } from "./tDigest";
import { ThetaSketch } from "./thetaSketch";
import { churnStream, distinctValues, TEST_CONSTANTS, trialRng } from "./testUtils";
import type { Structure, StructureOptions } from "./types";

const feed = (s: Structure, values: readonly number[]) => values.forEach((value) => s.ingest({ op: "insert", value }));

describe("merging", () => {
  it("MinHash: the merge of two streams' sketches is the sketch of both streams, exactly (the smaller minimum in every slot), counts both streams' inserts and deletes, and refuses another size or seed", () => {
    const values = distinctValues(trialRng("merge-minhash", 0), 500);
    const make = (o: Partial<StructureOptions> = {}) => new MinHash({ spaceBits: 2048, ...o }, TEST_CONSTANTS);
    const a = make();
    const b = make();
    const both = make();
    feed(a, values.slice(0, 300));
    feed(b, values.slice(200));
    feed(both, values);
    a.ingest({ op: "delete", value: values[0] as number });
    b.ingest({ op: "delete", value: values[1] as number });
    b.ingest({ op: "delete", value: values[2] as number });
    const merged = a.merge(b);
    expect([...merged.signature]).toEqual([...both.signature]);
    expect(merged.inserts).toBe(300 + 300);
    expect(merged.deletes).toBe(3);
    expect(a.inserts).toBe(300); // the originals are not changed
    expect(() => a.merge(make({ spaceBits: 4096 }))).toThrow();
    expect(() => a.merge(make({ hashSeed: 7 }))).toThrow();
    expect(() => a.merge(new TDigest({ spaceBits: 2048 }, TEST_CONSTANTS))).toThrow();
  });

  it("KLL Sketch and t-digest: the merge holds every unit of both (the weights add up), and its quantiles are within the sketch's calibrated rank error of the union's truth, over many streams", () => {
    for (const kind of ["kll", "tdigest"] as const) {
      let worst = 0;
      for (let t = 0; t < 60; t++) {
        const rng = trialRng(`merge-quantile-${kind}`, t);
        const values = distinctValues(rng, 800);
        const left = churnStream(rng, values.slice(0, 500), 2500, 0, { skewed: true });
        const right = churnStream(rng, values.slice(300), 2500, 0);
        const make = () => (kind === "kll" ? new KllSketch({ spaceBits: 8192 }, TEST_CONSTANTS) : new TDigest({ spaceBits: 8192 }, TEST_CONSTANTS));
        const a = make();
        const b = make();
        for (const e of left.events) a.ingest(e);
        for (const e of right.events) b.ingest(e);
        const merged = a.merge?.(b) as KllSketch | TDigest;
        expect(merged.inserts).toBe(5000);
        const total = kind === "kll" ? (merged as KllSketch).items.reduce((sum, item) => sum + item.weight, 0) : (merged as TDigest).summary.reduce((sum, c) => sum + c.weight, 0);
        expect(total).toBe(5000); // t-digest: exactly; KLL: promotions keep the total of weights exact
        const units = [...left.live.liveValues().flatMap((v) => Array.from({ length: left.live.count(v) }, () => v)), ...right.live.liveValues().flatMap((v) => Array.from({ length: right.live.count(v) }, () => v))].sort((x, y) => x - y);
        for (const q of [0.1, 0.5, 0.9]) {
          const v = merged.quantile(q) as number;
          const below = units.filter((x) => x <= v).length / units.length;
          const strictly = units.filter((x) => x < v).length / units.length;
          worst = Math.max(worst, Math.max(0, q - below, strictly - q));
        }
      }
      const bound = kind === "kll" ? (TEST_CONSTANTS.kllRankError / new KllSketch({ spaceBits: 8192 }, TEST_CONSTANTS).params.k!) * 2 : new TDigest({ spaceBits: 8192 }, TEST_CONSTANTS).rankError(0.5) * 3;
      expect(worst, kind).toBeLessThan(bound);
    }
  });

  it("Theta Sketch: counts like K-Minimum Values; merges into the sketch of the union, whose count is the union's within the same error; has a theta of 1 until it is full; refuses a different kind; snapshots, clones", () => {
    const rng = trialRng("merge-theta", 0);
    const values = distinctValues(rng, 3000);
    const make = () => new ThetaSketch({ spaceBits: 8192 }, TEST_CONSTANTS);
    const a = make();
    const b = make();
    feed(a, values.slice(0, 1800));
    feed(b, values.slice(1200));
    expect(a.params).toEqual({ k: 256 });
    expect(a.theta).toBeLessThan(0.2);
    const small = make();
    feed(small, values.slice(0, 100));
    expect(small.theta).toBe(1);
    expect(small.query({ kind: "count" })).toMatchObject({ estimate: 100, low: 100, high: 100 });
    const merged = a.merge(b);
    const union = merged.query({ kind: "count" });
    expect(Math.abs((union?.estimate as number) - 3000) / 3000).toBeLessThan(4 / Math.sqrt(254));
    expect(union?.low).toBeLessThanOrEqual(3000);
    expect(union?.high).toBeGreaterThanOrEqual(3000);
    expect(merged.theta).toBeLessThanOrEqual(Math.min(a.theta, b.theta));
    expect(a.query({ kind: "frequency", value: 1 })).toBeNull();
    expect(() => a.merge(new MinHash({ spaceBits: 2048 }, TEST_CONSTANTS))).toThrow();
    const back = ThetaSketch.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), TEST_CONSTANTS);
    expect(back.snapshot()).toEqual(a.snapshot());
    const copy = a.clone();
    feed(copy, [424242]);
    expect(copy.snapshot()).not.toEqual(a.snapshot());
    expect(() => ThetaSketch.fromSnapshot({ ...a.snapshot(), kind: "kMinimumValues" }, TEST_CONSTANTS)).toThrow(RangeError);
    expect(() => ThetaSketch.fromSnapshot({ ...a.snapshot(), state: {} }, TEST_CONSTANTS)).toThrow(RangeError);
  });
});
