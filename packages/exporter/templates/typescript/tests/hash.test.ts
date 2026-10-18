import assert from "node:assert/strict";
import { test } from "node:test";
import { hash32, positions } from "../src/hash.ts";
import { vectors } from "./helpers.ts";

test("hashing matches the reference answers for integers and strings, and seeds change the result", () => {
  for (const c of vectors.hash) assert.equal(hash32(c.item, c.seed), c.hash, `hash of ${JSON.stringify(c.item)} with seed ${c.seed}`);
  assert.notEqual(hash32(42, 1), hash32(42, 2));
  assert.equal(hash32(new TextEncoder().encode("hello"), 0), hash32("hello", 0));
  assert.throws(() => hash32(-1), RangeError);
  assert.throws(() => hash32(1.5), RangeError);
});

test("positions match the reference answers and stay inside the table", () => {
  for (const c of vectors.positions) assert.deepEqual(positions(c.item, c.k, c.modulus, c.seed), c.positions);
});
