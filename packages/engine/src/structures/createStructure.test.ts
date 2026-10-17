import { describe, expect, it } from "vitest";
import { eachCase } from "../testCases";
import { createStructure, type StructureKind } from "./index";
import { TEST_CONSTANTS } from "./testUtils";

const KINDS: StructureKind[] = [
  "exactMemory",
  "reservoirSampling",
  "bloomFilter",
  "countMinSketch",
  "logLog",
  "linearCounting",
  "hyperLogLog",
];

describe("createStructure", () => {
  it("builds every kind within its assigned Space; ingests events into every kind without mutating its clone", () => {
    // builds every kind within its assigned Space
    {
      eachCase(KINDS.map((kind) => [kind, kind] as const), (kind) => {
        const s = createStructure(kind, { spaceBits: 2048 }, TEST_CONSTANTS);
        expect(s.kind).toBe(kind);
        expect(s.spaceBits()).toBeLessThanOrEqual(2048);
        expect(s.spaceBits()).toBeGreaterThan(0);
      });
    }
    // ingests events into every kind without mutating its clone
    {
      eachCase(KINDS.map((kind) => [kind, kind] as const), (kind) => {
        const s = createStructure(kind, { spaceBits: 2048 }, TEST_CONSTANTS);
        const clone = s.clone();
        s.ingest({ op: "insert", value: 123 });
        expect(clone.kind).toBe(kind);
        expect(clone.spaceBits()).toBe(s.spaceBits());
      });
    }
  });
});
