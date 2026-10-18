import assert from "node:assert/strict";
import { test } from "node:test";
import * as sizing from "../sizing.ts";
import { vectors } from "./helpers.ts";

test("sizing matches the reference answers for every structure", () => {
  const functions = sizing as unknown as Record<string, (workload: object) => Record<string, number | boolean>>;
  for (const c of vectors.sizing) {
    const result = functions[c.fn]?.(c.input) as Record<string, number | boolean>;
    for (const [key, expected] of Object.entries(c.output)) {
      if (typeof expected === "number") assert.ok(Math.abs((result[key] as number) - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${c.fn} ${JSON.stringify(c.input)} ${key}`);
      else assert.equal(result[key], expected, `${c.fn} ${JSON.stringify(c.input)} ${key}`);
    }
  }
});

test("sizing refuses what it cannot size", () => {
  assert.throws(() => sizing.sizeBloom({ error: 0.01 }), RangeError);
  assert.throws(() => sizing.sizeHyperLogLog({ distinct: 100, error: 0 }), RangeError);
  assert.throws(() => sizing.sizeHyperLogLog({ distinct: 100, error: 1.5 }), RangeError);
});
