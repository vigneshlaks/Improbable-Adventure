import assert from "node:assert/strict";
import { test } from "node:test";
import { SpectralBloom } from "../src/spectralBloom.ts";
import { sizeSpectral } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a Spectral Bloom Filter matches the reference answers, counts exactly when alone, takes counts back, and stops a counter at its top", () => {
  const v = vectors.spectral;
  const filter = new SpectralBloom(v.counters, v.hashes);
  for (let i = 0; i < v.events; i++) filter.add(stream(i % v.distinct));
  for (let i = 0; i < v.removed; i++) filter.remove(stream(i % 5));
  v.estimates.forEach((expected: number, i: number) => assert.equal(filter.estimate(stream(i)), expected));
  v.present.forEach((expected: boolean, i: number) => assert.equal(filter.mightContain(stream(i + 30)), expected, `present ${i}`));
  assert.equal(filter.overshoot, v.overshoot);
  assert.equal(filter.falsePositiveRate, v.falsePositiveRate);

  const alone = new SpectralBloom(1024, 4);
  alone.add("apple", 5);
  assert.equal(alone.estimate("apple"), 5);
  assert.equal(alone.mightContain("apple"), true);
  alone.remove("apple", 5);
  assert.equal(alone.estimate("apple"), 0);
  assert.equal(alone.mightContain("apple"), false); // forgotten, unlike a Bloom Filter
  assert.equal(alone.liveTotal, 0);

  const narrow = new SpectralBloom(64, 3, undefined, 4); // counters stop at 15
  narrow.add("x", 40);
  assert.equal(narrow.estimate("x"), 15);
  narrow.remove("x", 3); // a stopped counter is left alone
  assert.equal(narrow.estimate("x"), 15);
  assert.throws(() => new SpectralBloom(0, 3), RangeError);
  assert.throws(() => new SpectralBloom(8, 3, undefined, 1), RangeError);
});

test(`statistical (${TRIALS} seeded trials): never undercounts, overshoots the band no more often than e^-hashes, and flags a never-added item no more often than the stated rate`, () => {
  const sized = sizeSpectral({ items: 3000, error: 0.02 });
  let under = 0;
  let over = 0;
  let total = 0;
  let falseYes = 0;
  let probes = 0;
  let reported = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(13000 + t);
    const values = Array.from({ length: 200 }, () => randomU32(random));
    const truth = new Map<number, number>();
    const filter = new SpectralBloom(sized.counters, sized.hashes);
    for (let i = 0; i < 3000; i++) {
      const value = values[Math.floor(200 * random() ** 2) as number] as number; // a few heavy values
      filter.add(value);
      truth.set(value, (truth.get(value) ?? 0) + 1);
    }
    for (const value of values) {
      const diff = filter.estimate(value) - (truth.get(value) ?? 0);
      if (diff < 0) under++;
      if (diff > filter.overshoot) over++;
      total++;
    }
    reported += filter.falsePositiveRate;
    for (let i = 0; i < 200; i++) {
      probes++;
      if (filter.mightContain(randomU32(random))) falseYes++;
    }
  }
  assert.equal(under, 0);
  assert.ok(over / total <= Math.exp(-sized.hashes), `over ${over / total}`);
  assert.ok(falseYes / probes <= (reported / TRIALS) * 1.3 + 0.002, `false yes ${falseYes / probes} against ${reported / TRIALS}`);
});
