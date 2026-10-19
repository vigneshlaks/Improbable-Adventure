import assert from "node:assert/strict";
import { test } from "node:test";
import { BloomFilter } from "../src/bloomFilter.ts";
import { ScalableBloomFilter } from "../src/scalableBloom.ts";
import { sizeScalable } from "../sizing.ts";
import { randomU32, seededRandom, TRIALS } from "./helpers.ts";

test("a Scalable Bloom Filter adds a layer when one fills, never misses an item, takes no room for a repeat, and rejects bad sizes", () => {
  const filter = new ScalableBloomFilter(100, 0.01);
  assert.equal(filter.layerCount, 1);
  const first = filter.memoryBits;
  const random = seededRandom(1);
  const items = Array.from({ length: 100 }, () => randomU32(random));
  for (const item of items) filter.add(item);
  for (const item of items) filter.add(item); // repeats take no room
  assert.equal(filter.layerCount, 1);
  filter.add(randomU32(random));
  assert.equal(filter.layerCount, 2); // the first layer was full
  assert.ok(filter.memoryBits > first * 2);
  for (const item of items) assert.ok(filter.mightContain(item));
  for (let i = 0; i < 1000; i++) filter.add(randomU32(random));
  assert.ok(filter.layerCount >= 4);
  assert.throws(() => new ScalableBloomFilter(0, 0.01), RangeError);
  assert.throws(() => new ScalableBloomFilter(10, 1), RangeError);
});

test(`statistical (${TRIALS} seeded trials): however far the set grows past the first guess, the false-positive rate stays under the one asked for, and a plain filter sized for the first guess does not`, () => {
  const asked = 0.02;
  const sized = sizeScalable({ items: 700, error: asked });
  assert.equal(sized.initialCapacity, 100);
  let falseYes = 0;
  let plainFalseYes = 0;
  let probes = 0;
  let reported = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(14000 + t);
    const scalable = new ScalableBloomFilter(sized.initialCapacity, asked);
    const plain = new BloomFilter(Math.ceil((-100 * Math.log(asked)) / Math.LN2 ** 2), 6); // sized for the first 100 items only
    const added = new Set<number>();
    for (let i = 0; i < 700; i++) {
      const value = randomU32(random);
      scalable.add(value);
      plain.add(value);
      added.add(value);
    }
    for (const value of added) assert.ok(scalable.mightContain(value));
    for (let i = 0; i < 200; i++) {
      const stranger = randomU32(random);
      if (added.has(stranger)) continue;
      probes++;
      if (scalable.mightContain(stranger)) falseYes++;
      if (plain.mightContain(stranger)) plainFalseYes++;
    }
    assert.ok(scalable.falsePositiveRate <= asked, `reported ${scalable.falsePositiveRate}`);
    reported += scalable.falsePositiveRate;
  }
  assert.ok(falseYes / probes <= asked * 1.3, `false yes ${falseYes / probes}`);
  assert.ok(falseYes / probes <= (reported / TRIALS) * 1.3 + 0.002, `the layers' reported rate ${reported / TRIALS} is below what happens: ${falseYes / probes}`);
  assert.ok(plainFalseYes / probes > 0.2, `the plain filter was past its size: ${plainFalseYes / probes}`);
});
