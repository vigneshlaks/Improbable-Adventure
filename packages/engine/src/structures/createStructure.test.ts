import { describe, expect, it } from "vitest";
import { createStructure, type StructureKind } from "./index";
import { TEST_CONSTANTS } from "./testUtils";

const KINDS: StructureKind[] = [
  "exactMemory",
  "reservoirSampling",
  "bloomFilter",
  "countMinSketch",
  "logLog",
  "linearCounting",
];

describe("createStructure", () => {
  it.each(KINDS)("builds %s within its assigned Space", (kind) => {
    const s = createStructure(kind, { spaceBits: 2048 }, TEST_CONSTANTS);
    expect(s.kind).toBe(kind);
    expect(s.spaceBits()).toBeLessThanOrEqual(2048);
    expect(s.spaceBits()).toBeGreaterThan(0);
  });

  it.each(KINDS)("%s ingests events without mutating its clone", (kind) => {
    const s = createStructure(kind, { spaceBits: 2048 }, TEST_CONSTANTS);
    const clone = s.clone();
    s.ingest({ op: "insert", value: 123 });
    expect(clone.kind).toBe(kind);
    expect(clone.spaceBits()).toBe(s.spaceBits());
  });
});
