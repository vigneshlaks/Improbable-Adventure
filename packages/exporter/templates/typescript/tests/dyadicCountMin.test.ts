import assert from "node:assert/strict";
import { test } from "node:test";
import { DyadicCountMin } from "../src/dyadicCountMin.ts";
import { sizeDyadic } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, vectors } from "./helpers.ts";

test("a Dyadic Count-Min matches the reference answers, takes counts back, and ranks values in order without ever ranking one too low", () => {
  const v = vectors.dyadic;
  const sketch = new DyadicCountMin(v.bits, v.width, v.depth);
  for (let i = 0; i < v.items; i++) sketch.add(stream(i));
  for (let i = 0; i < v.removed; i++) sketch.remove(stream(i));
  assert.equal(sketch.liveTotal, v.items - v.removed);
  for (const q of v.quantiles) {
    const answer = sketch.quantile(q.quantile);
    assert.equal(answer?.estimate, q.estimate, `estimate at ${q.quantile}`);
    assert.equal(answer?.low, q.low, `low at ${q.quantile}`);
    assert.equal(answer?.high, q.high === null ? Number.POSITIVE_INFINITY : q.high, `high at ${q.quantile}`);
  }

  const exact = new DyadicCountMin(8, 4096, 3); // wide sketches: nothing collides, so the counts are exact
  const values = Array.from({ length: 200 }, (_, i) => stream(i));
  for (const value of values) exact.add(value);
  const sorted = [...values].sort((a, b) => a - b);
  for (const probe of [sorted[0], sorted[50], sorted[100], sorted[199]] as number[]) {
    const bucket = probe >>> 24;
    assert.equal(exact.rank(probe), sorted.filter((x) => x >>> 24 <= bucket).length);
  }
  assert.ok(exact.rank(sorted[10] as number) <= exact.rank(sorted[150] as number)); // ranks go up with the value
  assert.equal(exact.rank(0xffffffff), 200);
  assert.equal(new DyadicCountMin(8, 64, 3).quantile(0.5), null);
  assert.throws(() => exact.rank(-1), RangeError);
  assert.throws(() => new DyadicCountMin(1, 8, 3), RangeError);
  const empty = new DyadicCountMin(8, 64, 3);
  empty.remove(5); // nothing to take back
  assert.equal(empty.liveTotal, 0);
});

test("statistical (200 seeded trials): the rank of a value is never too low and is too high by at most the stated band for the stated share of queries; the sizing plans for it", () => {
  const sized = sizeDyadic({ error: 0.2 });
  assert.equal(sized.bits, 32);
  assert.ok(sized.rankError <= 0.2);
  // 16 bits of the value keeps the test quick: 10 levels are sketches, each of width ceil(10 e / error) and a depth for a union bound over them
  const width = Math.ceil((10 * Math.E) / 0.2);
  const depth = Math.ceil(Math.log(10 / (1 - 0.95)));
  let under = 0;
  let over = 0;
  let total = 0;
  for (let t = 0; t < 200; t++) {
    const random = seededRandom(18000 + t);
    const sketch = new DyadicCountMin(16, width, depth, randomU32(random));
    const values = Array.from({ length: 400 }, () => randomU32(random));
    for (const value of values) sketch.add(value);
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 0; i < 20; i++) {
      const probe = values[Math.floor(random() * values.length)] as number;
      const truth = sorted.filter((x) => x >>> 16 <= probe >>> 16).length;
      const diff = sketch.rank(probe) - truth;
      if (diff < 0) under++;
      if (diff > sketch.rankOvershoot) over++;
      total++;
    }
  }
  assert.equal(under, 0);
  assert.ok(over / total <= 1 - coverageFloor(0.95, 200) + 0.0001, `over ${over / total}`);
});
