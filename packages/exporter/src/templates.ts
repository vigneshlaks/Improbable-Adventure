import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language, TemplateSet } from "./toolkit";

const ROOT = fileURLToPath(new URL("../templates", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Reads a language's templates and the shared known answers from disk (the browser build bundles them instead). */
export function loadTemplates(language: Language): TemplateSet {
  const base = join(ROOT, language);
  const files: Record<string, string> = {};
  for (const path of walk(base)) {
    const name = relative(base, path).split("\\").join("/");
    if (name.startsWith("__pycache__") || name.includes("/__pycache__/") || name.endsWith(".pyc") || name.startsWith("node_modules")) continue;
    files[name] = readFileSync(path, "utf8");
  }
  return { files, vectors: readFileSync(join(ROOT, "shared", "vectors.json"), "utf8") };
}

export const VECTORS_PATH = join(ROOT, "shared", "vectors.json");
