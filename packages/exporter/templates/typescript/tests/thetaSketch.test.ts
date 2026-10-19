import assert from "node:assert/strict";
import { test } from "node:test";
import { ThetaSketch } from "../src/thetaSketch.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Theta Sketch matches the reference answers, counts exactly while small, and combines into the union and the intersection", () => {
  const v = vectors.theta;
  const left = new ThetaSketch(v.k);
  const right = new ThetaSketch(v.k);
  for (let i = v.left.from; i < v.left.to; i++) left.add(stream(i));
  for (let i = v.right.from; i < v.right.to; i++) right.add(stream(i));
  assert.equal(left.theta, v.thetaLeft);
  assert.ok(Math.abs(left.count() - v.countLeft) < 1e-9 * v.countLeft);
  assert.ok(Math.abs(left.union(right).count() - v.countUnion) < 1e-9 * v.countUnion);
  assert.deepEqual([...left.hashes].slice(0, v.hashes.length), v.hashes);

  const a = new ThetaSketch(v.k);
  const b = new ThetaSketch(v.k);
  for (let i = 0; i < 40; i++) a.add(i);
  for (let i = 20; i < 50; i++) b.add(i);
  for (let i = 0; i < 40; i++) a.add(i); // repeats change nothing
  assert.equal(a.theta, 1);
  assert.equal(a.count(), 40);
  assert.equal(a.union(b).count(), 50);
  assert.equal(a.intersectionCount(b), 20);
  assert.equal(left.union(right).count() > left.count(), true);
  assert.throws(() => a.union(new ThetaSketch(v.k + 1)), Error);
  assert.throws(() => a.intersectionCount(new ThetaSketch(v.k, 5)), Error);
});

test(`statistical (${TRIALS} seeded trials): the union and the intersection are estimated without bias and with the spread the sample size gives`, () => {
  const k = 256;
  const only = 2000; // each stream has 2000 items of its own and 2000 in common: the union is 6000, the intersection 2000
  const unions: number[] = [];
  const intersections: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(22000 + t);
    const seed = randomU32(random);
    const values = Array.from({ length: 3 * only }, () => randomU32(random));
    const left = new ThetaSketch(k, seed);
    const right = new ThetaSketch(k, seed);
    for (const v of values.slice(0, 2 * only)) left.add(v);
    for (const v of [...values.slice(only, 2 * only), ...values.slice(2 * only)]) right.add(v);
    unions.push(left.union(right).count());
    intersections.push(left.intersectionCount(right));
  }
  const stats = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) };
  };
  const union = stats(unions);
  assert.ok(Math.abs(union.mean - 3 * only) / (3 * only) < 0.01, `union mean ${union.mean}`);
  assert.ok(union.sd / (3 * only) <= (1 / Math.sqrt(k - 2)) * 1.1, `union spread ${union.sd / (3 * only)}`);
  const common = stats(intersections);
  const expectedSpread = Math.sqrt((3 * only) / k - 1) / Math.sqrt(only); // sqrt((union / k - 1) / intersection), relative to the intersection
  assert.ok(Math.abs(common.mean - only) / only < 4 * expectedSpread / Math.sqrt(TRIALS), `intersection mean ${common.mean}`);
  assert.ok(common.sd / only <= expectedSpread * 1.2, `intersection spread ${common.sd / only} against ${expectedSpread}`);
  assert.ok(common.sd / only >= expectedSpread * 0.6);
});
