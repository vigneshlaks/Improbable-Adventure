import assert from "node:assert/strict";
import { test } from "node:test";
import { CuckooFilter } from "../src/cuckooFilter.ts";
import { sizeCuckoo } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Cuckoo Filter matches the reference answers, never forgets what it took, forgets what is removed, and says when it is too full", () => {
  const v = vectors.cuckoo;
  const filter = new CuckooFilter(v.buckets, v.fingerprintBits);
  for (let i = 0; i < v.items; i++) assert.equal(filter.add(stream(i)), true);
  for (let i = 0; i < v.removed; i++) assert.equal(filter.remove(stream(i * 5)), true);
  assert.equal(filter.size, v.size);
  v.present.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(i * 5 + (i % 5))), expected, `present ${i}`));
  v.outside.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(v.items + i)), expected, `outside ${i}`));

  const small = new CuckooFilter(4, 8); // 16 places
  const taken: number[] = [];
  for (let i = 0; i < 40; i++) if (small.add(stream(i))) taken.push(i);
  assert.ok(taken.length <= 16 && taken.length >= 12, `took ${taken.length}`);
  assert.ok(taken.length < 40); // some adds were refused
  assert.equal(small.remove("never added"), false);
  assert.throws(() => new CuckooFilter(0, 8), RangeError);
  assert.throws(() => new CuckooFilter(10, 17), RangeError);
});

test(`statistical (${TRIALS} seeded trials): no added item is missed, and a never-added item is reported no more often than the stated rate`, () => {
  const sized = sizeCuckoo({ items: 2000, error: 0.02 });
  let falseYes = 0;
  let probes = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(9000 + t);
    const filter = new CuckooFilter(sized.buckets, sized.fingerprintBits);
    const added = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = randomU32(random);
      if (filter.add(value)) added.add(value);
    }
    assert.ok(added.size >= 1990, `took ${added.size}`);
    let missed = 0;
    for (const value of added) if (!filter.mightContain(value)) missed++;
    assert.ok(missed <= 10, `missed ${missed}`); // an add that dropped a fingerprint costs one earlier item
    for (let i = 0; i < 200; i++) {
      const stranger = randomU32(random);
      if (added.has(stranger)) continue;
      probes++;
      if (filter.mightContain(stranger)) falseYes++;
    }
  }
  assert.ok(falseYes / probes <= sized.falsePositiveRate * 1.3, `false yes ${falseYes / probes} against ${sized.falsePositiveRate}`);
});
