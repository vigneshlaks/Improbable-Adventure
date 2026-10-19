import assert from "node:assert/strict";
import { test } from "node:test";
import { TDigest } from "../src/tDigest.ts";
import { sizeTDigest } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a t-digest matches the reference answers, keeps its extremes exactly, holds every value in its weights, and merges", () => {
  const v = vectors.tDigest;
  const digest = new TDigest(v.compression);
  for (let i = 0; i < v.items; i++) digest.add(stream(i));
  // The reference rounds a quantile to a whole number; the centroid arithmetic uses sin and asin, which may differ in the last digit between machines.
  assert.ok(Math.abs(digest.summary.length - v.centroids) <= 1);
  for (const q of v.quantiles) assert.ok(Math.abs((digest.quantile(q.quantile) as number) - q.value) <= 1 + 1e-6 * q.value, `quantile ${q.quantile}`);
  assert.equal(digest.summary.reduce((sum, c) => sum + c.weight, 0), v.items);
  const values = Array.from({ length: v.items }, (_, i) => stream(i));
  assert.equal(digest.quantile(0), Math.min(...values));
  assert.equal(digest.quantile(1), Math.max(...values));
  assert.ok(digest.summary.length <= v.compression);

  const small = new TDigest(v.compression); // fewer values than centroids: every value is its own centroid
  for (let i = 1; i <= 20; i++) small.add(i * 10);
  assert.equal(small.quantile(0.5), 100 + 5); // interpolated between the two middle values
  assert.equal(new TDigest(v.compression).quantile(0.5), null);

  const left = new TDigest(v.compression);
  const right = new TDigest(v.compression);
  for (let i = 0; i < 3000; i++) (i % 2 === 0 ? left : right).add(stream(i));
  const both = left.merge(right);
  assert.equal(both.count, 3000);
  assert.equal(both.summary.reduce((sum, c) => sum + c.weight, 0), 3000);
  assert.equal(left.count, 1500);
  assert.throws(() => left.merge(new TDigest(v.compression + 1)), Error);
  assert.throws(() => new TDigest(4), RangeError);
  assert.throws(() => small.add(Number.POSITIVE_INFINITY), RangeError);
  assert.equal(new TDigest(100).rankError(0.5), 0.02);
});

test(`statistical (${TRIALS} seeded trials): the rank error at a quantile stays within the stated 4 sqrt(q (1 - q)) / compression for 95 percent of streams, and the stated error is smaller in the tails`, () => {
  const sized = sizeTDigest({ error: 0.05 });
  const byQuantile = new Map<number, number[]>();
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(17000 + t);
    const values = Array.from({ length: 3000 }, () => randomU32(random));
    const digest = new TDigest(sized.compression);
    for (const value of values) digest.add(value);
    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.01, 0.5, 0.99]) {
      const v = digest.quantile(q) as number;
      const below = sorted.filter((x) => x <= v).length / sorted.length;
      const strictly = sorted.filter((x) => x < v).length / sorted.length;
      byQuantile.set(q, [...(byQuantile.get(q) ?? []), Math.max(0, q - below, strictly - q)]);
    }
  }
  const p95 = (q: number) => (byQuantile.get(q) as number[]).sort((a, b) => a - b)[Math.floor(TRIALS * 0.95)] as number;
  const stated = (q: number) => new TDigest(sized.compression).rankError(q);
  for (const q of [0.01, 0.5, 0.99]) assert.ok(p95(q) <= stated(q), `quantile ${q}: ${p95(q)} against ${stated(q)}`);
  assert.ok(stated(0.01) < stated(0.5) / 4 && stated(0.99) < stated(0.5) / 4, "the stated error is far smaller in the tails");
  assert.ok(sized.rankError >= stated(0.5) - 1e-12);
});
