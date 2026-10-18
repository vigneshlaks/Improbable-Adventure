import assert from "node:assert/strict";
import { test } from "node:test";
import { HyperLogLog } from "../src/hyperLogLog.ts";
import { sizeHyperLogLog } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a HyperLogLog matches the reference answers, ignores repeats, merges, and rejects bad sizes", () => {
  for (const c of vectors.hyperLogLog) {
    const hll = new HyperLogLog(c.indexBits);
    for (let i = 0; i < c.items; i++) hll.add(stream(i));
    assert.ok(Math.abs(hll.estimate() - c.estimate) < 1e-6 * c.estimate, `estimate for ${c.items} items`);
  }
  const hll = new HyperLogLog(8);
  for (let i = 0; i < 100; i++) for (let repeat = 0; repeat < 5; repeat++) hll.add(stream(i));
  const once = new HyperLogLog(8);
  for (let i = 0; i < 100; i++) once.add(stream(i));
  assert.equal(hll.estimate(), once.estimate());

  const left = new HyperLogLog(10);
  const right = new HyperLogLog(10);
  const both = new HyperLogLog(10);
  for (let i = 0; i < 3000; i++) {
    (i % 2 === 0 ? left : right).add(stream(i));
    both.add(stream(i));
  }
  left.merge(right);
  assert.equal(left.estimate(), both.estimate());
  assert.throws(() => left.merge(new HyperLogLog(9)), RangeError);
  assert.throws(() => new HyperLogLog(3), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the estimate is within two standard errors for the stated share of streams`, () => {
  const sized = sizeHyperLogLog({ distinct: 20000, error: 0.02 });
  let inside = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(3000 + t);
    const hll = new HyperLogLog(sized.indexBits);
    for (let i = 0; i < 20000; i++) hll.add(randomU32(random));
    if (Math.abs(hll.estimate() - 20000) / 20000 <= 1.96 * hll.standardError) inside++;
  }
  assert.ok(inside / TRIALS >= coverageFloor(0.95, TRIALS), `inside ${inside / TRIALS}`);
});
