import assert from "node:assert/strict";
import { test } from "node:test";
import { KMinimumValues } from "../src/kMinimumValues.ts";
import { sizeKmv } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("K-Minimum Values matches the reference answers, counts exactly while small, ignores repeats, and merges", () => {
  const v = vectors.kmv;
  const sketch = new KMinimumValues(v.k);
  for (let i = 0; i < v.items; i++) sketch.add(stream(i));
  assert.ok(Math.abs(sketch.count() - v.count) < 1e-6 * v.count);
  assert.deepEqual([...sketch.hashes].slice(0, v.hashes.length), v.hashes);

  const small = new KMinimumValues(v.k);
  for (let i = 0; i < v.small.items; i++) small.add(stream(i));
  assert.equal(small.count(), v.small.count);
  assert.equal(small.standardError, 0);
  for (let i = 0; i < v.small.items; i++) small.add(stream(i)); // repeats change nothing
  assert.equal(small.count(), v.small.count);

  const other = new KMinimumValues(v.k);
  for (let i = v.mergedWith.from; i < v.mergedWith.to; i++) other.add(stream(i));
  assert.ok(Math.abs(sketch.merge(other).count() - v.mergedWith.count) < 1e-6 * v.mergedWith.count);
  assert.throws(() => sketch.merge(new KMinimumValues(v.k + 1)), Error);
  assert.throws(() => new KMinimumValues(2), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the estimate is within two standard errors for the stated share of streams`, () => {
  const sized = sizeKmv({ error: 0.05 });
  let inside = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(10000 + t);
    const sketch = new KMinimumValues(sized.k);
    for (let i = 0; i < 20000; i++) sketch.add(randomU32(random));
    if (Math.abs(sketch.count() - 20000) / 20000 <= 1.96 * sketch.standardError) inside++;
  }
  assert.ok(inside / TRIALS >= coverageFloor(0.95, TRIALS), `inside ${inside / TRIALS}`);
});
