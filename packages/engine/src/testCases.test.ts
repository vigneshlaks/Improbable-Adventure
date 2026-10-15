import { expect, it } from "vitest";
import { eachCase } from "./testCases";

it("eachCase runs every case, passes when all pass, and names every failing case", () => {
  const seen: number[] = [];
  eachCase([["a", 1], ["b", 2]], (value) => seen.push(value));
  expect(seen).toEqual([1, 2]);

  const run = () =>
    eachCase([["one", 1], ["two", 2], ["three", 3]], (value) => {
      if (value !== 2) throw new Error(`bad ${value}`);
    });
  expect(run).toThrow(/2 of 3 cases failed/);
  expect(run).toThrow(/one: bad 1/);
  expect(run).toThrow(/three: bad 3/);
  expect(run).not.toThrow(/two:/);
});
