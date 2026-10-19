import assert from "node:assert/strict";
import { test } from "node:test";
import { CountSketch } from "../src/countSketch.ts";
import { sizeCountSketch } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Count Sketch matches the reference answers, counts exactly when alone, and takes counts back exactly", () => {
  const v = vectors.countSketch;
  const sketch = new CountSketch(v.width, v.depth);
  for (let i = 0; i < v.events; i++) sketch.add(stream(i % v.distinct));
  for (let i = 0; i < v.removed; i++) sketch.remove(stream(i % 7));
  v.estimates.forEach((expected: number, i: number) => assert.equal(sketch.rawEstimate(stream(i)), expected));
  assert.equal(sketch.squaredNorm, v.squaredNorm);

  const alone = new CountSketch(1024, 5);
  alone.add("apple", 5);
  assert.equal(alone.estimate("apple"), 5);
  assert.ok(Math.abs(alone.errorBand - (2 * 5) / Math.sqrt(1024)) < 1e-12); // 2 x sqrt(25 / width)
  alone.remove("apple", 2);
  assert.equal(alone.estimate("apple"), 3);
  alone.remove("apple", 3);
  assert.equal(alone.estimate("apple"), 0);
  assert.equal(alone.squaredNorm, 0); // nothing is left of it
  alone.remove("pear", 4); // a count can go below zero, and the estimate is then clamped
  assert.equal(alone.rawEstimate("pear"), -4);
  assert.equal(alone.estimate("pear"), 0);
});

test(`statistical (${TRIALS} seeded trials): the estimate is within error x L2 norm of the truth for the stated share of queries, and is not biased to one side`, () => {
  const sized = sizeCountSketch({ error: 0.3 });
  let inside = 0;
  let total = 0;
  let below = 0;
  let above = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(8000 + t);
    const values = Array.from({ length: 100 }, () => randomU32(random));
    const truth = new Map<number, number>();
    const sketch = new CountSketch(sized.width, sized.depth);
    for (let i = 0; i < 1000; i++) {
      const value = values[Math.floor(100 * random() ** 2) as number] as number; // a few heavy values
      sketch.add(value);
      truth.set(value, (truth.get(value) ?? 0) + 1);
    }
    const norm = Math.sqrt([...truth.values()].reduce((sum, count) => sum + count * count, 0));
    for (const value of values) {
      const diff = sketch.rawEstimate(value) - (truth.get(value) ?? 0);
      if (Math.abs(diff) <= sized.errorShare * norm) inside++;
      if (diff < 0) below++;
      if (diff > 0) above++;
      total++;
    }
  }
  assert.ok(inside / total >= coverageFloor(sized.confidence, TRIALS), `inside ${inside / total}`);
  assert.ok(below / (below + above) > 0.25 && below / (below + above) < 0.75, `below ${below / (below + above)}`); // unbiased: errors go both ways
});
