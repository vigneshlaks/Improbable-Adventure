import assert from "node:assert/strict";
import { test } from "node:test";
import { bandRowsFor, candidateChance, LshIndex } from "../src/lshIndex.ts";
import { sizeLsh } from "../sizing.ts";
import { randomU32, seededRandom, stream, vectors } from "./helpers.ts";

test("an LSH index matches the reference answers, finds a stored set that is alike the query and not one that is not, and checks its candidates with MinHash", () => {
  const v = vectors.lsh;
  assert.equal(bandRowsFor(v.k, v.threshold, v.recall), v.rows);
  const index = new LshIndex(v.k, v.threshold, v.recall);
  assert.equal(index.rows, v.rows);
  assert.equal(index.bands, Math.floor(v.k / v.rows));
  index.add("stream", Array.from({ length: v.items.to - v.items.from }, (_, i) => stream(v.items.from + i)));
  for (const c of v.copies) {
    const copy = Array.from({ length: c.to - c.from }, (_, i) => stream(c.from + i));
    assert.equal(index.query(copy).includes("stream"), c.candidate, `copy ${c.from} to ${c.to}`);
  }

  // many stored sets: the query finds the ones that share most of its items
  const many = new LshIndex(128);
  for (let s = 0; s < 20; s++) many.add(`set-${s}`, Array.from({ length: 100 }, (_, i) => 1_000_000 * s + i));
  many.add("overlap", Array.from({ length: 100 }, (_, i) => 1_000_000 * 7 + 10 + i)); // 90 of set 7's 100 items
  const found = many.query(Array.from({ length: 100 }, (_, i) => 1_000_000 * 7 + i));
  assert.ok(found.includes("set-7") && found.includes("overlap"));
  assert.equal(found.length, 2); // the other eighteen sets share nothing
  const check = many.signature("set-7")!.similarity(many.signature("overlap")!);
  assert.ok(check > 0.7 && check < 1, `a candidate is checked with MinHash: ${check}`);
  assert.deepEqual(many.query([]), []); // nothing to look for
  assert.throws(() => many.add("set-7", [1, 2, 3]), Error);
  assert.throws(() => new LshIndex(0), RangeError);
  assert.throws(() => new LshIndex(64, 1.5), RangeError);
  assert.ok(Math.abs(candidateChance(0.5, 2, 3) - (1 - 0.75 ** 3)) < 1e-12);
  assert.equal(bandRowsFor(1, 0.6, 0.9), 1);
});

test("statistical (100 seeded trials): two sets of a given similarity are found as candidates with the chance 1 - (1 - s^rows)^bands, at several similarities, and a pair above the threshold is found almost always", () => {
  const trials = 100;
  const index0 = new LshIndex(64);
  const { rows, bands } = index0;
  for (const s of [0.3, 0.5, 0.7, 0.9]) {
    const shared = Math.round((200 * s) / (1 + s)); // two sets of 100 sharing `shared`: J = shared / (200 - shared)
    const truth = shared / (200 - shared);
    let found = 0;
    for (let t = 0; t < trials; t++) {
      const random = seededRandom(20000 + t);
      const values = Array.from({ length: 200 - shared }, () => randomU32(random));
      const index = new LshIndex(64, 0.6, 0.9, randomU32(random));
      index.add("a", values.slice(0, 100));
      if (index.query([...values.slice(0, shared), ...values.slice(100)]).includes("a")) found++;
    }
    const chance = candidateChance(truth, rows, bands);
    const sigma = Math.sqrt((chance * (1 - chance)) / trials);
    assert.ok(Math.abs(found / trials - chance) < 4 * sigma + 0.02, `similarity ${s}: found ${found / trials} against ${chance}`);
    if (s >= 0.7) assert.ok(found / trials >= 0.9, `a pair at ${s} is found: ${found / trials}`);
  }
  // sizing: the rows and bands it asks for find a pair at the threshold with the recall asked
  const sized = sizeLsh({ error: 0.05 });
  assert.ok(sized.recall >= 0.95 && sized.k === sized.rows * sized.bands);
});
