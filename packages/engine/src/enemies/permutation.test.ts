import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { makePermutation } from "./permutation";

describe("makePermutation", () => {
  it("is a bijection on 0..n-1 for sizes from 1 to 65537", () => {
    const sizes = [1, 2, 3, 5, 100, 255, 256, 1000, 4096, 65537];
    eachCase(sizes.map((n) => [`n = ${n}`, n] as const), (n) => {
      const p = makePermutation(n, 12345);
      const seen = new Set<number>();
      for (let x = 0; x < n; x++) {
        const y = p(x);
        expect(Number.isInteger(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(n);
        seen.add(y);
      }
      expect(seen.size).toBe(n);
    });
  });

  it("is deterministic and depends on the key", () => {
    const a = makePermutation(1000, 1);
    const b = makePermutation(1000, 1);
    const c = makePermutation(1000, 2);
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    expect(xs.map(a)).toEqual(xs.map(b));
    expect(xs.map(a)).not.toEqual(xs.map(c));
  });

  it("shuffles: few inputs map to themselves", () => {
    const p = makePermutation(1000, 99);
    const fixed = Array.from({ length: 1000 }, (_, i) => i).filter((i) => p(i) === i).length;
    expect(fixed).toBeLessThan(20); // a random permutation has about 1 fixed point on average
  });

  it("works at the largest Variety size without a table", () => {
    const n = 2 ** 22;
    const p = makePermutation(n, 7);
    const outputs = new Set<number>();
    for (let x = 0; x < 5000; x++) {
      const y = p(x);
      expect(y).toBeLessThan(n);
      outputs.add(y);
    }
    expect(outputs.size).toBe(5000); // distinct inputs give distinct outputs
  });

  it("rejects bad sizes and inputs", () => {
    expect(() => makePermutation(0, 1)).toThrow(RangeError);
    expect(() => makePermutation(2.5, 1)).toThrow(RangeError);
    expect(() => makePermutation(10, 1)(10)).toThrow(RangeError);
    expect(() => makePermutation(10, 1)(-1)).toThrow(RangeError);
  });
});
