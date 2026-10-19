import assert from "node:assert/strict";
import { test } from "node:test";
import { QuotientFilter } from "../src/quotientFilter.ts";
import { sizeQuotient } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Quotient Filter matches the reference answers, never misses an item it took, forgets what is removed, refuses adds when full, and merges", () => {
  const v = vectors.quotient;
  const filter = new QuotientFilter(v.quotientBits, v.remainderBits);
  for (let i = 0; i < v.items; i++) assert.equal(filter.add(stream(i)), true);
  for (let i = 0; i < v.removed; i++) assert.equal(filter.remove(stream(i * 3)), true);
  assert.equal(filter.size, v.size);
  assert.equal(filter.falsePositiveRate, v.falsePositiveRate);
  v.present.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(i * 4 + (i % 4))), expected, `present ${i}`));
  v.outside.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(v.items + i)), expected, `outside ${i}`));
  assert.equal(filter.memoryBits, 2 ** v.quotientBits * (v.remainderBits + 3));
  const twice = new QuotientFilter(v.quotientBits, v.remainderBits);
  twice.add("a");
  twice.add("a");
  twice.remove("a"); // one copy of the fingerprint goes, and the other stays
  assert.equal(twice.mightContain("a"), true);
  assert.equal(twice.size, 1);

  const other = new QuotientFilter(v.quotientBits, v.remainderBits);
  for (let i = v.merged.from; i < v.merged.to; i++) other.add(stream(i));
  const merged = filter.merge(other);
  assert.equal(merged.size, v.merged.size);
  v.merged.probes.forEach((expected: boolean, i: number) => assert.equal(merged.mightContain(stream(150 + i * 8)), expected, `merged ${i}`));
  assert.equal(filter.size, v.size); // the originals are not changed
  assert.throws(() => filter.merge(new QuotientFilter(v.quotientBits, v.remainderBits - 1)), Error);

  const small = new QuotientFilter(4, 8); // 16 slots
  for (let i = 0; i < 16; i++) assert.equal(small.add(stream(i)), true);
  assert.equal(small.add(stream(99)), false);
  assert.equal(small.load, 1);
  assert.equal(small.remove("never added"), false);
  assert.throws(() => new QuotientFilter(1, 8), RangeError);
  assert.throws(() => new QuotientFilter(20, 16), RangeError);
});

test(`statistical (${TRIALS} seeded trials): no added item is missed, and a never-added item is reported no more often than the stated rate`, () => {
  const sized = sizeQuotient({ items: 2000, error: 0.02 });
  let falseYes = 0;
  let probes = 0;
  let reported = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(12000 + t);
    const filter = new QuotientFilter(sized.quotientBits, sized.remainderBits);
    const added = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = randomU32(random);
      assert.equal(filter.add(value), true);
      added.add(value);
    }
    for (const value of added) assert.ok(filter.mightContain(value));
    reported += filter.falsePositiveRate;
    for (let i = 0; i < 200; i++) {
      const stranger = randomU32(random);
      if (added.has(stranger)) continue;
      probes++;
      if (filter.mightContain(stranger)) falseYes++;
    }
  }
  assert.ok(sized.falsePositiveRate <= 0.02);
  assert.ok(falseYes / probes <= (reported / TRIALS) * 1.3 + 0.001, `false yes ${falseYes / probes} against ${reported / TRIALS}`);
  assert.ok(reported / TRIALS <= sized.falsePositiveRate * 1.01, `reported ${reported / TRIALS} against ${sized.falsePositiveRate}`);
});
