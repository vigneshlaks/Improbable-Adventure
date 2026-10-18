import type { StructureKind } from "@pda/engine";

export type Language = "typescript" | "python";

/** Template files by path relative to `templates/<language>`, and the shared known answers. */
export interface TemplateSet {
  files: Record<string, string>;
  /** The contents of `templates/shared/vectors.json`. */
  vectors: string;
}

interface Layout {
  /** The source file of each structure (without extension), and the files it needs besides its own. */
  structures: Record<StructureKind, { name: string; needs: string[] }>;
  extension: string;
  /** Files every toolkit has, whatever the player owns. */
  always: string[];
  sourceDir: string;
  testDir: string;
  testName: (name: string) => string;
}

const STRUCTURES = {
  exactMemory: { typescript: "exactMemory", python: "exact_memory", needs: [] },
  reservoirSampling: { typescript: "reservoirSampling", python: "reservoir_sampling", needs: [] },
  bloomFilter: { typescript: "bloomFilter", python: "bloom_filter", needs: [] },
  countMinSketch: { typescript: "countMinSketch", python: "count_min_sketch", needs: [] },
  linearCounting: { typescript: "linearCounting", python: "linear_counting", needs: [] },
  logLog: { typescript: "logLog", python: "log_log", needs: ["registers"] },
  hyperLogLog: { typescript: "hyperLogLog", python: "hyper_log_log", needs: ["registers"] },
} satisfies Record<StructureKind, { typescript: string; python: string; needs: string[] }>;

function layoutFor(language: Language): Layout {
  const pick = (kind: StructureKind) => ({ name: STRUCTURES[kind][language], needs: STRUCTURES[kind].needs });
  const structures = Object.fromEntries((Object.keys(STRUCTURES) as StructureKind[]).map((kind) => [kind, pick(kind)])) as Layout["structures"];
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
    const { name, needs } = layout.structures[kind];
    wanted.add(`${layout.sourceDir}/${name}.${layout.extension}`);
    wanted.add(`${layout.testDir}/${layout.testName(name)}`);
    for (const need of needs) wanted.add(`${layout.sourceDir}/${need}.${layout.extension}`);
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
