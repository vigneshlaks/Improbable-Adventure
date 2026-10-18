import assert from "node:assert/strict";
import { test } from "node:test";
import { BloomFilter } from "../src/bloomFilter.ts";
import { sizeBloom } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Bloom Filter matches the reference answers, never misses an added item, and rejects bad sizes", () => {
  const v = vectors.bloom;
  const filter = new BloomFilter(v.bits, v.hashes);
  for (let i = 0; i < v.items; i++) filter.add(stream(i));
  assert.ok(Math.abs(filter.fill - v.fill) < 1e-12);
  v.probes.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(v.items + i)), expected));
  for (let i = 0; i < v.items; i++) assert.ok(filter.mightContain(stream(i)));
  assert.throws(() => new BloomFilter(0, 3), RangeError);
});

test(`statistical (${TRIALS} seeded trials): a filter sized for 1% flags at most 1.3% of new items`, () => {
  const sized = sizeBloom({ items: 1000, error: 0.01 });
  let flagged = 0;
  let probes = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(1000 + t);
    const filter = new BloomFilter(sized.bits, sized.hashes);
    for (let i = 0; i < 1000; i++) filter.add(randomU32(random));
    for (let i = 0; i < 200; i++) {
      if (filter.mightContain(randomU32(random))) flagged++;
      probes++;
    }
  }
  assert.ok(flagged / probes <= 0.01 * 1.3, `rate ${flagged / probes}`);
});
