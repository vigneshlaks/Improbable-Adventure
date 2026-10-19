import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { createStructure, STRUCTURE_KINDS, type Challenge } from "@pda/engine";
import structuresJson from "../structures.json";
import { findStructure, parseStructures, structures } from "./structures";
import { structureConstants } from "./balance";

const PROBES: Challenge[] = [
  { kind: "presence", targets: [1, 2, 3] },
  { kind: "frequency", value: 1 },
  { kind: "count" },
  { kind: "rank", quantile: 0.5 },
  { kind: "likeness", targets: [0], copies: [[1, 2, 3]], threshold: 0.6 },
];

describe("structures.json", () => {
  it("describes exactly the structures the engine has; lists, for every structure, the questions the engine structure answers; gives every structure a knob range the engine accepts; and 4 more", () => {
    // describes exactly the structures the engine has
    {
      expect(Object.keys(structures).sort()).toEqual([...STRUCTURE_KINDS].sort());
    }
    // lists, for every structure, the questions the engine structure answers
    {
      eachCase(STRUCTURE_KINDS.map((kind) => [kind, kind] as const), (kind) => {
        const engineStructure = createStructure(kind, { spaceBits: 8192 }, structureConstants());
        const answered = PROBES.filter((probe) => engineStructure.query(probe) !== null).map((probe) => probe.kind);
        expect([...structures[kind].answers].sort()).toEqual(answered.sort());
      });
    }
    // gives every structure a knob range the engine accepts
    {
      eachCase(STRUCTURE_KINDS.map((kind) => [kind, kind] as const), (kind) => {
        const knob = structures[kind].knob;
        if (!knob) return;
        expect(knob.min).toBeLessThanOrEqual(knob.max);
        for (const value of [knob.min, knob.max]) {
          expect(() => createStructure(kind, { spaceBits: 8192, knob: value }, structureConstants())).not.toThrow();
        }
      });
    }
    // gives every structure text for help and flavor
    {
      for (const info of Object.values(structures)) {
        expect(info.name.length).toBeGreaterThan(0);
        expect(info.summary.length).toBeGreaterThan(10);
        expect(info.help.length).toBeGreaterThan(40);
        expect(info.flavor.length).toBeGreaterThan(10);
      }
    }
    // has unique lowercase aliases that find their structure
    {
      const seen = new Map<string, string>();
      for (const [kind, info] of Object.entries(structures)) {
        for (const alias of info.aliases) {
          expect(alias).toBe(alias.toLowerCase());
          expect(seen.has(alias), `alias "${alias}" is used twice`).toBe(false);
          seen.set(alias, kind);
          expect(findStructure(alias)).toBe(kind);
        }
      }
    }
    // finds a structure by its kind or display name, ignoring case, and returns null otherwise
    {
      expect(findStructure("BLOOM")).toBe("bloomFilter");
      expect(findStructure("bloomFilter")).toBe("bloomFilter");
      expect(findStructure("Count-Min Sketch")).toBe("countMinSketch");
      expect(findStructure("skiplist")).toBeNull();
    }
    // rejects a structure that is missing a field or has an unknown one
    {
      const { help: _help, ...withoutHelp } = structuresJson.bloomFilter;
      void _help;
      expect(() => parseStructures({ ...structuresJson, bloomFilter: withoutHelp })).toThrow();
      expect(() => parseStructures({ ...structuresJson, bloomFilter: { ...structuresJson.bloomFilter, extra: 1 } })).toThrow();
      expect(() => parseStructures({ ...structuresJson, skipList: structuresJson.bloomFilter })).toThrow();
    }
  });
});
