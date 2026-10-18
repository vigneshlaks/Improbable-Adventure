import { describe, expect, it } from "vitest";
import { parseWorkload } from "./workload";

describe("parseWorkload", () => {
  it("reads blanks as not given, the error as a percentage, and refuses what cannot be a workload", () => {
    expect(parseWorkload({ items: "", distinct: "", errorPercent: "", memoryKiB: "" })).toEqual({ ok: true, workload: {} });
    expect(parseWorkload({ items: " 1,000,000 ", distinct: "50000", errorPercent: "0.5", memoryKiB: "64" })).toEqual({
      ok: true,
      workload: { items: 1_000_000, distinct: 50_000, error: 0.005, memoryBits: 64 * 1024 * 8 },
    });
    for (const bad of [{ items: "abc" }, { items: "-5" }, { distinct: "0" }, { errorPercent: "0" }, { errorPercent: "100" }, { errorPercent: "150" }, { memoryKiB: "-1" }]) {
      const result = parseWorkload({ items: "", distinct: "", errorPercent: "", memoryKiB: "", ...bad });
      expect(result.ok).toBe(false);
    }
    expect(parseWorkload({ items: "10", distinct: "10", errorPercent: "", memoryKiB: "" })).toEqual({ ok: true, workload: { items: 10, distinct: 10 } }); // every item different is fine
    expect(parseWorkload({ items: "10", distinct: "20", errorPercent: "", memoryKiB: "" })).toMatchObject({ ok: false, message: expect.stringContaining("different items") });
  });
});
