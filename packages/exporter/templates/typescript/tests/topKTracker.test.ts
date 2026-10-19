import assert from "node:assert/strict";
import { test } from "node:test";
import { TopKTracker } from "../src/topKTracker.ts";
import { sizeTopK } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, vectors } from "./helpers.ts";

test("a Top-K Tracker matches the reference answers, tracks the heaviest items with tight intervals, takes counts back, and frees the place of an item that is gone", () => {
  const v = vectors.topK;
  const tracker = new TopKTracker(v.width, v.depth, v.capacity);
  const value = (i: number) => stream(Math.floor(60 * (((i * 7919) % 1000) / 1000) ** 2));
  for (let i = 0; i < 3000; i++) tracker.add(value(i));
  for (let i = 0; i < 200; i++) tracker.remove(value(i * 3));
  assert.deepEqual(tracker.heavyHitters().slice(0, v.candidates.length).map((c) => ({ item: c.item, low: c.low, high: c.high })), v.candidates);
  for (const e of v.estimates) assert.deepEqual(tracker.estimate(e.item), { low: e.low, high: e.high }, `item ${e.item}`);

  const alone = new TopKTracker(256, 3, 2);
  for (let i = 0; i < 5; i++) alone.add("apple");
  for (let i = 0; i < 3; i++) alone.add("pear");
  alone.add("plum");
  alone.add("plum");
  alone.add("plum"); // the list holds two: apple, pear; plum is answered by the sketch
  assert.equal(alone.heavyHitters().length, 2);
  assert.deepEqual(alone.estimate("apple"), { low: 5, high: 5 });
  for (let i = 0; i < 5; i++) alone.remove("apple");
  assert.equal(alone.heavyHitters().some((c) => c.item === "apple"), false); // nothing of it is left
  assert.ok(alone.estimate("apple").high <= 1);
  const single = new TopKTracker(256, 3, 1);
  single.add("first");
  single.add("second"); // as heavy as the one listed, not heavier: it does not take the place
  assert.deepEqual(single.heavyHitters().map((c) => c.item), ["first"]);
  single.add("second");
  assert.deepEqual(single.heavyHitters().map((c) => c.item), ["second"]); // now it is heavier
  assert.throws(() => new TopKTracker(10, 3, 0), RangeError);
});

test("statistical (100 seeded trials): the heaviest items are on the list, and the interval of each holds its true count for the stated share of items", () => {
  const sized = sizeTopK({ error: 0.05 });
  let heavy = 0;
  let found = 0;
  let inside = 0;
  let listed = 0;
  const trials = 100;
  for (let t = 0; t < trials; t++) {
    const random = seededRandom(19000 + t);
    const values = Array.from({ length: 200 }, () => randomU32(random));
    const truth = new Map<number, number>();
    const tracker = new TopKTracker(sized.width, sized.depth, sized.capacity);
    for (let i = 0; i < 2000; i++) {
      const v = values[Math.floor(200 * random() ** 3) as number] as number; // a few heavy items
      tracker.add(v);
      truth.set(v, (truth.get(v) ?? 0) + 1);
    }
    const onList = new Set(tracker.heavyHitters().map((c) => c.item));
    for (const [item, count] of truth) if (count >= 0.1 * 2000) { heavy++; if (onList.has(item)) found++; } // items with at least twice the error's share
    for (const c of tracker.heavyHitters()) {
      listed++;
      const real = truth.get(c.item as number) ?? 0;
      if (c.low <= real && real <= c.high) inside++;
    }
  }
  assert.ok(heavy > 50, `there are heavy items to find: ${heavy}`);
  assert.equal(found, heavy); // every item with at least 10 percent of the stream is on the list
  assert.ok(inside / listed >= coverageFloor(sized.confidence, listed), `inside ${inside / listed}`);
});
