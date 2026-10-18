import assert from "node:assert/strict";
import { test } from "node:test";
import { ReservoirSampling } from "../src/reservoirSampling.ts";
import { sizeReservoir } from "../sizing.ts";
import { coverageFloor, seededRandom, TRIALS } from "./helpers.ts";

test("a reservoir keeps everything until it is full, then a fixed-size sample, and is repeatable with a seeded generator", () => {
  const small = new ReservoirSampling(10, seededRandom(1));
  for (let i = 0; i < 7; i++) small.add(i);
  assert.deepEqual(small.sample(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(small.estimateCount(3), 1);
  for (let i = 7; i < 1000; i++) small.add(i);
  assert.equal(small.sample().length, 10);
  assert.equal(small.seen, 1000);
  const again = new ReservoirSampling(10, seededRandom(1));
  for (let i = 0; i < 1000; i++) again.add(i);
  assert.deepEqual(again.sample(), small.sample());
  assert.throws(() => new ReservoirSampling(0), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the share of a stream estimated from a sample sized for 5% is within 5% at the stated confidence`, () => {
  const sized = sizeReservoir({ error: 0.05 });
  let inside = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(6000 + t);
    const reservoir = new ReservoirSampling(sized.sampleSize, random);
    for (let i = 0; i < 5000; i++) reservoir.add(i);
    const truth = 0.3; // the first 1,500 of the 5,000 items
    if (Math.abs(reservoir.estimateShare((item) => (item as number) < 1500) - truth) <= 0.05) inside++;
  }
  assert.ok(inside / TRIALS >= coverageFloor(0.95, TRIALS), `inside ${inside / TRIALS}`);
});
