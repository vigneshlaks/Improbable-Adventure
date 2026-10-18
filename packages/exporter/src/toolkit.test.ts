import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { structureConstants } from "@pda/content";
import { STRUCTURE_KINDS } from "@pda/engine";
import { loadTemplates, VECTORS_PATH } from "./templates";
import { generateToolkit, hasTemplate, type Language } from "./toolkit";
import { buildVectors } from "./vectors";

describe("toolkit", () => {
  it("ships the engine's known answers, and only the files for the structures the player owns", () => {
    // The committed vectors are what the game's structures give today; `pnpm export vectors` rewrites them after a deliberate change.
    expect(JSON.parse(readFileSync(VECTORS_PATH, "utf8"))).toEqual(JSON.parse(JSON.stringify(buildVectors(structureConstants()))));

    for (const language of ["typescript", "python"] as Language[]) {
      const templates = loadTemplates(language);
      const all = generateToolkit(language, STRUCTURE_KINDS, templates);
      expect(Object.keys(all).filter((path) => path.startsWith("src/")).length).toBeGreaterThanOrEqual(STRUCTURE_KINDS.filter(hasTemplate).length + 1);
      // A structure with no templates yet is left out, not an error.
      expect(Object.keys(all).some((path) => /count_?sketch\.|top_?k/i.test(path))).toBe(false);
      expect(hasTemplate("countSketch")).toBe(false);
      expect(hasTemplate("bloomFilter")).toBe(true);
      expect(all["tests/vectors.json"]).toBe(templates.vectors);

      // LogLog alone brings the register helper it needs, and none of the other structures.
      const one = Object.keys(generateToolkit(language, ["logLog"], templates));
      expect(one.some((path) => /registers\./.test(path))).toBe(true);
      expect(one.some((path) => /bloom/i.test(path))).toBe(false);
      expect(one.some((path) => /log_?log/i.test(path) && path.includes("test"))).toBe(true);

      expect(() => generateToolkit(language, STRUCTURE_KINDS, { ...templates, files: {} })).toThrow(/no file/);
    }
  });
});
