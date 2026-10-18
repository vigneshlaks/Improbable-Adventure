import assert from "node:assert/strict";
import { test } from "node:test";
import { ExactMemory } from "../src/exactMemory.ts";

test("exact memory counts every item exactly, takes counts back, and never goes below zero", () => {
  const table = new ExactMemory();
  table.add("a", 3);
  table.add(7);
  table.add("a");
  assert.equal(table.count("a"), 4);
  assert.equal(table.count(7), 1);
  assert.equal(table.count("never"), 0);
  assert.equal(table.distinct, 2);
  assert.equal(table.total, 5);
  table.remove("a", 3);
  assert.equal(table.count("a"), 1);
  table.remove("a", 10);
  assert.equal(table.count("a"), 0);
  assert.equal(table.distinct, 1);
  assert.equal(table.total, 1);
});
