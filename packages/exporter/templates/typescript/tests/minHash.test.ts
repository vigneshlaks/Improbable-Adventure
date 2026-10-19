import assert from "node:assert/strict";
import { test } from "node:test";
import { MinHash } from "../src/minHash.ts";
import { sizeMinHash } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a MinHash matches the reference answers, sees equal sets as equal and strangers as strangers, ignores repeats, and merges", () => {
  const v = vectors.minHash;
  const left = new MinHash(v.k);
  const right = new MinHash(v.k);
  for (let i = v.left.from; i < v.left.to; i++) left.add(stream(i));
  for (let i = v.right.from; i < v.right.to; i++) right.add(stream(i));
  assert.deepEqual([...left.signature].slice(0, v.signature.length), v.signature);
  assert.equal(left.similarity(right), v.similarity);
  assert.deepEqual([...left.merge(right).signature].slice(0, v.merged.length), v.merged);

  const same = new MinHash(v.k);
  for (let i = v.left.from; i < v.left.to; i++) same.add(stream(i));
  for (let i = v.left.from; i < v.left.to; i++) same.add(stream(i)); // repeats change nothing
  assert.equal(left.similarity(same), 1);
  const stranger = new MinHash(v.k);
  for (let i = 5000; i < 5300; i++) stranger.add(stream(i));
  assert.ok(left.similarity(stranger) < 0.1);
  assert.equal(new MinHash(v.k).similarity(new MinHash(v.k)), 0); // two empty sets agree on nothing
  assert.equal(new MinHash(16).standardError, 0.125); // 1 / (2 sqrt(16))
  assert.throws(() => left.similarity(new MinHash(v.k + 1)), Error);
  assert.throws(() => new MinHash(0), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the estimate is unbiased and its spread is no more than the stated standard error, at several similarities`, () => {
  const sized = sizeMinHash({ error: 0.1 });
  for (const j of [0.2, 0.5, 0.8]) {
    const shared = Math.round((400 * j) / (1 + j)); // two sets of 200 sharing `shared`: J = shared / (400 - shared)
    const truth = shared / (400 - shared);
    const estimates: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const random = seededRandom(11000 + t);
      const values = Array.from({ length: 400 - shared }, () => randomU32(random));
      const a = new MinHash(sized.k);
      const b = new MinHash(sized.k);
      for (const value of values.slice(0, 200)) a.add(value);
      for (const value of [...values.slice(0, shared), ...values.slice(200)]) b.add(value);
      estimates.push(a.similarity(b));
    }
    const mean = estimates.reduce((x, y) => x + y, 0) / TRIALS;
    const sd = Math.sqrt(estimates.reduce((x, y) => x + (y - mean) ** 2, 0) / TRIALS);
    assert.ok(sd <= sized.standardError * 1.1, `spread ${sd} at ${j}`);
    assert.ok(Math.abs(mean - truth) <= (4 * sized.standardError) / Math.sqrt(TRIALS), `mean ${mean} against ${truth}`);
  }
});
