import assert from "node:assert/strict";
import { test } from "node:test";
import { HyperMinHash } from "../src/hyperMinHash.ts";
import { sizeHyperMinHash } from "../sizing.ts";
import { randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a HyperMinHash matches the reference answers, counts the different items, sees equal sets as alike and strangers as strangers, and merges", () => {
  const v = vectors.hyperMinHash;
  const sketch = new HyperMinHash(v.indexBits);
  for (let i = 0; i < v.items; i++) sketch.add(stream(i));
  assert.deepEqual([...sketch.registersOf(Array.from({ length: v.items }, (_, i) => stream(i)))].slice(0, v.registers.length), v.registers);
  assert.ok(Math.abs(sketch.cardinality() - v.cardinality) < 1e-9 * v.cardinality);
  for (const c of v.cases) {
    const result = sketch.similarityTo(Array.from({ length: c.to - c.from }, (_, i) => stream(c.from + i)));
    assert.ok(Math.abs(result.similarity - c.similarity) < 1e-9, `similarity of ${c.from} to ${c.to}`);
    assert.ok(Math.abs(result.collision - c.collision) < 1e-9);
    assert.equal(result.used, c.used);
  }
  assert.ok(Math.abs(sketch.cardinality() - v.items) / v.items < 4 * 1.04 / Math.sqrt(sketch.size));
  assert.equal(sketch.memoryBits, 8 * 2 ** v.indexBits);

  const empty = new HyperMinHash(v.indexBits);
  assert.equal(empty.similarityTo([1, 2, 3]).similarity, 0);
  assert.equal(empty.cardinality(), 0);

  const left = new HyperMinHash(v.indexBits);
  const right = new HyperMinHash(v.indexBits);
  const both = new HyperMinHash(v.indexBits);
  for (let i = 0; i < 1000; i++) {
    (i % 2 === 0 ? left : right).add(stream(i));
    both.add(stream(i));
  }
  assert.ok(Math.abs(left.merge(right).cardinality() - both.cardinality()) < 1e-9 * both.cardinality());
  assert.throws(() => left.merge(new HyperMinHash(v.indexBits + 1)), Error);
  assert.throws(() => new HyperMinHash(3), RangeError);
  assert.equal(new HyperMinHash(8).standardError, 1 / 32);
});

test(`statistical (${TRIALS} seeded trials): the estimated similarity is nearly unbiased and its spread is no more than 1.1 times the stated standard error, at several similarities`, () => {
  const sized = sizeHyperMinHash({ error: 0.05 });
  for (const j of [0.2, 0.5, 0.8]) {
    const shared = Math.round((400 * j) / (1 + j)); // two sets of 200 sharing `shared`: J = shared / (400 - shared)
    const truth = shared / (400 - shared);
    const estimates: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const random = seededRandom(21000 + t);
      const values = Array.from({ length: 400 - shared }, () => randomU32(random));
      const sketch = new HyperMinHash(sized.indexBits, randomU32(random));
      for (const value of values.slice(0, 200)) sketch.add(value);
      estimates.push(sketch.similarityTo([...values.slice(0, shared), ...values.slice(200)]).similarity);
    }
    const mean = estimates.reduce((x, y) => x + y, 0) / TRIALS;
    const sd = Math.sqrt(estimates.reduce((x, y) => x + (y - mean) ** 2, 0) / TRIALS);
    assert.ok(sd <= sized.standardError * 1.1, `spread ${sd} against ${sized.standardError} at ${j}`);
    assert.ok(Math.abs(mean - truth) <= 0.03, `mean ${mean} against ${truth}`);
  }
});
