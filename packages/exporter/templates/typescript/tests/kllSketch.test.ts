import assert from "node:assert/strict";
import { test } from "node:test";
import { KllSketch } from "../src/kllSketch.ts";
import { sizeKll } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a KLL Sketch matches the reference answers, is exact while small, ignores nothing it was given, and merges", () => {
  const v = vectors.kll;
  const sketch = new KllSketch(v.k);
  for (let i = 0; i < v.items; i++) sketch.add(stream(i));
  assert.equal(sketch.items.length, v.stored);
  for (const q of v.quantiles) assert.equal(sketch.quantile(q.quantile), q.value, `quantile ${q.quantile}`);
  for (const r of v.ranks) assert.equal(sketch.rank(r.value), r.rank, `rank of ${r.value}`);
  assert.equal(sketch.count, v.items);

  const small = new KllSketch(v.k); // fewer items than fit in the lowest level: nothing is dropped
  for (let i = 1; i <= 30; i++) small.add(i * 10);
  assert.equal(small.quantile(0.5), 150);
  assert.equal(small.quantile(1), 300);
  assert.equal(small.quantile(0.01), 10);
  assert.equal(small.rank(150), 0.5);
  assert.equal(new KllSketch(v.k).quantile(0.5), null);
  const seven = new KllSketch(v.k);
  for (let i = 1; i <= 7; i++) seven.add(i);
  assert.equal(seven.quantile(0.5), 4); // the 3.5th item is reached at the 4th

  const left = new KllSketch(v.k);
  const right = new KllSketch(v.k);
  for (let i = 0; i < 5000; i++) (i % 2 === 0 ? left : right).add(stream(i));
  const both = left.merge(right);
  assert.equal(both.count, 5000);
  assert.equal(both.items.reduce((sum, item) => sum + item.weight, 0), 5000); // every item is accounted for
  assert.ok(both.items.length <= 3 * v.k + 30, `the merge was compacted: ${both.items.length} items kept`);
  assert.ok(both.items.length < left.items.length + right.items.length);
  assert.equal(left.count, 2500); // the originals are not changed
  assert.throws(() => left.merge(new KllSketch(v.k + 1)), Error);
  assert.throws(() => new KllSketch(1), RangeError);
  assert.throws(() => small.add(Number.NaN), RangeError);
  assert.equal(new KllSketch(10).rankError, 0.16);
});

test(`statistical (${TRIALS} seeded trials): the rank error of a quantile stays within the stated 1.6 / k for 95 percent of queries, at several quantiles`, () => {
  const sized = sizeKll({ error: 0.05 });
  const errors: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(16000 + t);
    const values = Array.from({ length: 3000 }, () => randomU32(random));
    const sketch = new KllSketch(sized.k);
    for (const value of values) sketch.add(value);
    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.1, 0.5, 0.9, 0.99]) {
      const v = sketch.quantile(q) as number;
      const below = sorted.filter((x) => x <= v).length / sorted.length;
      const strictly = sorted.filter((x) => x < v).length / sorted.length;
      errors.push(Math.max(0, q - below, strictly - q));
    }
  }
  errors.sort((a, b) => a - b);
  const p95 = errors[Math.floor(errors.length * 0.95)] as number;
  assert.ok(p95 <= sized.rankError, `95th percentile of the error ${p95} against ${sized.rankError}`);
  assert.ok(p95 > sized.rankError * 0.2, `the stated error is not far above what happens: ${p95}`);
});
