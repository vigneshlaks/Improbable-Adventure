import { describe, expect, it } from "vitest";
import { structureConstants } from "@pda/content";
import { createStructure, FADING, Rng, STRUCTURE_KINDS, type StructureKind } from "@pda/engine";
import { createRunSession } from "./runSession";
import { downsample, MAX_VISUAL_CELLS, structureVisual } from "./visuals";

const constants = structureConstants();

function filled(kind: StructureKind, spaceBits: number, enchantment?: string) {
  const structure = createStructure(kind, { spaceBits, rng: Rng.fromSeed("visuals"), enchantment }, constants);
  for (let v = 1; v <= 300; v++) structure.ingest({ op: "insert", value: Math.imul(v, 2654435761) >>> 0 });
  return structure.snapshot();
}

describe("structureVisual", () => {
  it("draws every structure as 0..1 cells that grow with the stream, in at most 256 cells, with a readout", () => {
    const shapes: Record<string, string> = {};
    for (const kind of STRUCTURE_KINDS) {
      for (const enchantment of kind === "bloomFilter" ? [undefined, FADING] : [undefined]) {
        const visual = structureVisual(filled(kind, 4096, enchantment), 2, constants);
        shapes[kind + (enchantment ?? "")] = visual.shape;
        expect(visual.slot).toBe(2);
        expect(visual.cells.length).toBeGreaterThan(0);
        expect(visual.cells.length).toBeLessThanOrEqual(visual.shape === "heatmap" ? 4096 / 32 : MAX_VISUAL_CELLS);
        expect(visual.cells.every((c) => c >= 0 && c <= 1)).toBe(true);
        expect(Math.max(...visual.cells)).toBeGreaterThan(0);
        expect(visual.readout.length).toBeGreaterThan(0);
      }
    }
    expect(shapes).toMatchObject({ bloomFilter: "meter", countMinSketch: "heatmap", logLog: "bars", hyperLogLog: "bars", countSketch: "heatmap", topKTracker: "heatmap", cuckooFilter: "meter", kMinimumValues: "bars", kllSketch: "bars", tDigest: "bars", minHash: "bars" });
    // A heatmap keeps its grid shape, a Bloom readout reports its fill.
    const grid = structureVisual(filled("countMinSketch", 4096), 0, constants);
    expect(grid.columns).toBe(4096 / (32 * constants.cmsDefaultDepth)); // one row per hash, one column per counter
    expect(grid.cells.length).toBe(grid.columns * constants.cmsDefaultDepth);
    expect(structureVisual(filled("bloomFilter", 4096), 0, constants).readout).toMatch(/\d+% full/);
    expect(downsample([1, 0, 1, 0], 2)).toEqual([0.5, 0.5]);
  });

  it("is offered by a run session: one visual per deployed structure, and buttons for the next commands", () => {
    const session = createRunSession({ seed: "panel" });
    expect(session.structures()).toEqual([]);
    expect(session.suggestions()).toContain("status");
    session.handle("deploy bloom 400");
    const [visual] = session.structures();
    expect(visual?.label).toMatch(/Bloom/);
    session.handle("ready");
    expect(session.structures()[0]?.cells.some((c) => c > 0)).toBe(true);
  });
});
