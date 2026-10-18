import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearCounting } from "../src/linearCounting.ts";
import { sizeLinearCounting } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Linear Counting matches the reference answers, ignores repeats, and reports saturation", () => {
  const v = vectors.linearCounting;
  const counter = new LinearCounting(v.bits);
  for (let i = 0; i < v.items; i++) counter.add(stream(i));
  assert.ok(Math.abs(counter.estimate() - v.estimate) < 1e-9 * v.estimate);
  const before = counter.estimate();
  for (let i = 0; i < v.items; i++) counter.add(stream(i));
  assert.equal(counter.estimate(), before);

  const tiny = new LinearCounting(8);
  for (let i = 0; i < 500; i++) tiny.add(stream(i));
  assert.equal(tiny.saturated, true);
  assert.throws(() => new LinearCounting(0), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the estimate is within two standard errors for the stated share of streams`, () => {
  const sized = sizeLinearCounting({ distinct: 5000, error: 0.02 });
  let inside = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(5000 + t);
    const counter = new LinearCounting(sized.bits);
    for (let i = 0; i < 5000; i++) counter.add(randomU32(random));
    if (Math.abs(counter.estimate() - 5000) / 5000 <= 1.96 * counter.standardError(5000)) inside++;
  }
  assert.ok(inside / TRIALS >= coverageFloor(0.95, TRIALS), `inside ${inside / TRIALS}`);
});
