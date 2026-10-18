import assert from "node:assert/strict";
import { test } from "node:test";
import { CountMinSketch } from "../src/countMinSketch.ts";
import { sizeCountMin } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Count-Min Sketch matches the reference answers, counts exactly when alone, and takes counts back", () => {
  const v = vectors.countMin;
  const sketch = new CountMinSketch(v.width, v.depth);
  for (let i = 0; i < v.events; i++) sketch.add(stream(i % v.distinct));
  v.estimates.forEach((expected: number, i: number) => assert.equal(sketch.estimate(stream(i)), expected));

  const alone = new CountMinSketch(1024, 4);
  alone.add("apple", 5);
  assert.equal(alone.estimate("apple"), 5);
  alone.remove("apple", 2);
  assert.equal(alone.estimate("apple"), 3);
  alone.remove("apple", 10); // counters stop at zero
  assert.equal(alone.estimate("apple"), 0);
});

test(`statistical (${TRIALS} seeded trials): never underestimates, and overshoots the band no more often than e^-depth`, () => {
  const sized = sizeCountMin({ items: 3000, error: 0.02 });
  let under = 0;
  let over = 0;
  let total = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(2000 + t);
    const values = Array.from({ length: 200 }, () => randomU32(random));
    const truth = new Map<number, number>();
    const sketch = new CountMinSketch(sized.width, sized.depth);
    for (let i = 0; i < 3000; i++) {
      const value = values[Math.floor(200 * random() ** 2) as number] as number; // a few heavy values
      sketch.add(value);
      truth.set(value, (truth.get(value) ?? 0) + 1);
    }
    for (const value of values) {
      const diff = sketch.estimate(value) - (truth.get(value) ?? 0);
      if (diff < 0) under++;
      if (diff > sketch.overshoot) over++;
      total++;
    }
  }
  assert.equal(under, 0);
  assert.ok(over / total <= Math.exp(-sized.depth), `over ${over / total}`);
});
