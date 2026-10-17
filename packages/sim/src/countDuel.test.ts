import { describe, expect, it } from "vitest";
import { structureConstants } from "@pda/content";
import { countErrorTable, counterErrors, everSeen } from "./countDuel";

const constants = structureConstants();
const SPACE = 8192;
const values = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => (Math.imul(i + 1, 2654435761) + offset) >>> 0);

describe("everSeen", () => {
  it("lists every value that was ever inserted once: the live ones and the ghosts", () => {
    expect(everSeen({ items: [5, 5, 9], ghosts: [2, 7] }).sort()).toEqual([2, 5, 7, 9]);
    expect(everSeen({ items: [], ghosts: [] })).toEqual([]);
  });
});

describe("counterErrors", () => {
  it("gives each counter's relative error against the truth, at the same Space; measures against the truth it is given, not against the values it saw; shows Linear Counting failing once its bitmap saturates; and 1 more", () => {
    // gives each counter's relative error against the truth, at the same Space
    {
      const small = counterErrors(values(1000), 1000, SPACE, constants);
      expect(small.linearCounting).toBeLessThan(0.05);
      expect(small.logLog).toBeGreaterThan(small.linearCounting); // LogLog is biased on small streams
    }
    // measures against the truth it is given, not against the values it saw
    {
      const seen = values(1000);
      const exact = counterErrors(seen, 1000, SPACE, constants);
      const off = counterErrors(seen, 500, SPACE, constants);
      expect(off.linearCounting).toBeGreaterThan(0.9); // about 1000 against a truth of 500
      expect(off.linearCounting).not.toBeCloseTo(exact.linearCounting, 2);
    }
    // shows Linear Counting failing once its bitmap saturates
    {
      const big = counterErrors(values(150_000), 150_000, SPACE, constants);
      expect(big.logLog).toBeLessThan(0.2);
      expect(big.linearCounting).toBeGreaterThan(0.4);
    }
    // rejects a truth of zero
    {
      expect(() => counterErrors([], 0, SPACE, constants)).toThrow(RangeError);
    }
  });
});

describe("Linear Counting against LogLog at equal Space (8,192 bits, 40 seeded trials per size)", () => {
  const sizes = [50, 1000, 12_000, 25_000, 50_000, 80_000, 150_000];
  const table = countErrorTable(sizes, 40, SPACE, constants);
  const row = (distinct: number) => table.find((entry) => entry.distinct === distinct)!;

  it("keeps Linear Counting ahead from small streams up to 25,000 distinct values; puts LogLog ahead from 80,000 distinct values, where Linear Counting saturates; crosses over near 50,000 distinct values; and 1 more", () => {
    // keeps Linear Counting ahead from small streams up to 25,000 distinct values
    {
      for (const distinct of [50, 1000, 12_000, 25_000]) {
        expect(row(distinct).linearCountingRms).toBeLessThan(row(distinct).logLogRms);
      }
    }
    // puts LogLog ahead from 80,000 distinct values, where Linear Counting saturates
    {
      for (const distinct of [80_000, 150_000]) {
        expect(row(distinct).logLogRms).toBeLessThan(row(distinct).linearCountingRms);
      }
    }
    // crosses over near 50,000 distinct values
    {
      const at = row(50_000);
      expect(at.logLogRms / at.linearCountingRms).toBeGreaterThan(0.7);
      expect(at.logLogRms / at.linearCountingRms).toBeLessThan(1.4);
      expect(at.logLogCloserShare).toBeGreaterThan(0.3);
      expect(at.logLogCloserShare).toBeLessThan(0.7);
    }
    // shows LogLog's error settling at its theoretical level once the stream is large
    {
      const registers = 1024; // the largest power of two that fits 8,192 / 5 bits
      const theory = constants.logLogErrorCoefficient / Math.sqrt(registers);
      expect(row(150_000).logLogRms).toBeGreaterThan(theory * 0.7);
      expect(row(150_000).logLogRms).toBeLessThan(theory * 1.3);
    }
  });
});
