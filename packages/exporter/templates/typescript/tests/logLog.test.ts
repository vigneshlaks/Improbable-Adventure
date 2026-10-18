import assert from "node:assert/strict";
import { test } from "node:test";
import { LogLog } from "../src/logLog.ts";
import { sizeLogLog } from "../sizing.ts";
import { coverageFloor, randomU32, seededRandom, stream, TRIALS, vectors } from "./helpers.ts";

test("a LogLog matches the reference answers", () => {
  for (const c of vectors.logLog) {
    const counter = new LogLog(c.indexBits);
    for (let i = 0; i < c.items; i++) counter.add(stream(i));
    assert.ok(Math.abs(counter.estimate() - c.estimate) < 1e-6 * c.estimate, `estimate for ${c.items} items`);
  }
  assert.throws(() => new LogLog(21), RangeError);
});

test(`statistical (${TRIALS} seeded trials): the estimate is within two standard errors for the stated share of streams`, () => {
  const sized = sizeLogLog({ distinct: 50000, error: 0.05 });
  let inside = 0;
  for (let t = 0; t < TRIALS; t++) {
    const random = seededRandom(4000 + t);
    const counter = new LogLog(sized.indexBits);
    for (let i = 0; i < 50000; i++) counter.add(randomU32(random));
    if (Math.abs(counter.estimate() - 50000) / 50000 <= 1.96 * counter.standardError) inside++;
  }
  assert.ok(inside / TRIALS >= coverageFloor(0.95, TRIALS), `inside ${inside / TRIALS}`);
});
