import assert from "node:assert/strict";
import { test } from "node:test";
import { SimHash } from "../src/simHash.ts";
import { sizeSimHash } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a SimHash matches the reference answers, sees the same set as the same and strangers as half the planes apart, and is weak on duplicates", () => {
  const v = vectors.simHash;
  const hash = new SimHash(v.planes);
  for (let i = 0; i < v.items; i++) hash.add(stream(i));
  assert.ok(Math.abs(hash.effectiveSize() - v.effectiveSize) < 1e-9 * v.effectiveSize);
  for (const c of v.cases) {
    const copy = Array.from({ length: c.to - c.from }, (_, i) => stream(c.from + i));
    assert.equal(hash.differing(copy), c.differing);
    assert.ok(Math.abs(hash.similarity(copy) - c.similarity) < 1e-9, `similarity of ${c.from} to ${c.to}`);
  }
  const same = Array.from({ length: v.items }, (_, i) => stream(i));
  assert.equal(hash.differing(same), 0);
  assert.equal(hash.differing([...same, ...same.slice(0, 40)]), 0); // a repeated item in a set counts once

  // a stream where one item is added 150 times looks small: duplicates outweigh the rest
  const repeats = new SimHash(v.planes);
  for (let i = 0; i < v.items; i++) repeats.add(stream(i < 150 ? 0 : i));
  assert.ok(Math.abs(repeats.effectiveSize() - v.repeatsEffectiveSize) < 1e-9 * v.repeatsEffectiveSize);
  assert.ok(repeats.effectiveSize() < 0.7 * hash.effectiveSize());
  assert.equal(new SimHash(v.planes).effectiveSize(), 0);

  assert.ok(Math.abs(SimHash.similarityAt(0, 100, 100) - 1) < 1e-12);
  assert.ok(Math.abs(SimHash.similarityAt(1 / 3, 400, 400) - 200 / 600) < 1e-12); // cos 60 degrees = 0.5: shared 200, union 600
  assert.throws(() => new SimHash(48), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the share of planes that differ has the mean the angle gives and the spread of a binomial over the planes`, () => {
  const planes = sizeSimHash({ error: 0.03 }).planes;
  assert.equal(planes % 32, 0);
  for (const overlap of [0.2, 0.5, 0.8]) {
    // a stream of 200 items and a copy of 200 sharing `overlap` of them: cos = overlap, the share is acos(overlap) / pi
    const shared = Math.round(200 * overlap);
    const expected = Math.acos(shared / 200) / Math.PI;
    const shares: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const random = seededRandom(15000 + t);
      const values = Array.from({ length: 400 - shared }, () => randomU32(random));
      const hash = new SimHash(planes, randomU32(random));
      for (const value of values.slice(0, 200)) hash.add(value);
      shares.push(hash.differing([...values.slice(0, shared), ...values.slice(200)]));
    }
    const mean = shares.reduce((a, b) => a + b, 0) / TRIALS;
    const sd = Math.sqrt(shares.reduce((a, b) => a + (b - mean) ** 2, 0) / TRIALS);
    const theory = Math.sqrt((expected * (1 - expected)) / planes);
    assert.ok(Math.abs(mean - expected) < (4 * theory) / Math.sqrt(TRIALS) + 0.003, `mean ${mean} against ${expected} at ${overlap}`);
    assert.ok(sd < theory * 1.2 && sd > theory * 0.6, `spread ${sd} against ${theory} at ${overlap}`);
    assert.ok(sd <= new SimHash(planes).standardError * 1.1, `spread ${sd} against the stated ${new SimHash(planes).standardError}`);
  }
});
