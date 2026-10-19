import type { StructureKind } from "@pda/engine";
import { CATALOG, type CatalogEntry } from "./catalog";

export type Language = "typescript" | "python";

/** Template files by path relative to `templates/<language>`, and the shared known answers. */
export interface TemplateSet {
  files: Record<string, string>;
  /** The contents of `templates/shared/vectors.json`. */
  vectors: string;
}

interface Layout {
  /** The source file of each structure (without extension), and the files it needs besides its own. */
  structures: Partial<Record<StructureKind, { name: string; needs: string[] }>>;
  extension: string;
  /** Files every toolkit has, whatever the player owns. */
  always: string[];
  sourceDir: string;
  testDir: string;
  testName: (name: string) => string;
}

/** Whether a structure has templates, and so reference code, tests and a sizing function. */
export const hasTemplate = (kind: StructureKind): boolean => kind in CATALOG;

function layoutFor(language: Language): Layout {
  const structures: Layout["structures"] = {};
  for (const kind of Object.keys(CATALOG) as StructureKind[]) structures[kind] = { name: (CATALOG[kind] as CatalogEntry)[language], needs: CATALOG[kind]?.needs ?? [] };
  if (language === "typescript") {
    return { structures, extension: "ts", sourceDir: "src", testDir: "tests", testName: (name) => `${name}.test.ts`, always: ["package.json", "sizing.ts", "src/hash.ts", "tests/helpers.ts", "tests/hash.test.ts", "tests/sizing.test.ts"] };
  }
  return { structures, extension: "py", sourceDir: "src", testDir: "tests", testName: (name) => `test_${name}.py`, always: ["conftest.py", "sizing.py", "src/__init__.py", "src/hash.py", "tests/__init__.py", "tests/helpers.py", "tests/test_hash.py", "tests/test_sizing.py"] };
}

/**
 * The files of a toolkit for the structures the player owns: path to contents. Everything comes from the templates,
 * which are real, tested source files; nothing is written by this function except choosing which to include.
 */
export function generateToolkit(language: Language, owned: readonly StructureKind[], templates: TemplateSet): Record<string, string> {
  const layout = layoutFor(language);
  const wanted = new Set(layout.always);
  for (const kind of owned) {
    const entry = layout.structures[kind];
    if (!entry) continue; // no templates for this structure yet
    const { name, needs } = entry;
    wanted.add(`${layout.sourceDir}/${name}.${layout.extension}`);
    wanted.add(`${layout.testDir}/${layout.testName(name)}`);
    for (const need of needs) wanted.add(`${layout.sourceDir}/${language === "python" ? need.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) : need}.${layout.extension}`); // a helper file is named by its TypeScript name
  }
  const out: Record<string, string> = {};
  for (const path of [...wanted].sort()) {
    const content = templates.files[path];
    if (content === undefined) throw new Error(`The ${language} templates have no file ${path}`);
    out[path] = content;
  }
  out["tests/vectors.json"] = templates.vectors;
  return out;
}
