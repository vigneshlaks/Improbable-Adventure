import type { Language, TemplateSet } from "@pda/exporter";

// Vite reads every template file as text at build time, so the page needs no server to export.
const files = import.meta.glob(["../../exporter/templates/typescript/**/*", "../../exporter/templates/python/**/*", "../../exporter/templates/shared/*"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PREFIX = "../../exporter/templates/";

/** The templates of one language, and the shared known answers, in the shape the exporter takes. */
export function templatesFor(language: Language): TemplateSet {
  const own: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) if (path.startsWith(`${PREFIX}${language}/`)) own[path.slice(`${PREFIX}${language}/`.length)] = content;
  const vectors = files[`${PREFIX}shared/vectors.json`];
  if (vectors === undefined) throw new Error("The shared known answers are missing from the build");
  return { files: own, vectors };
}
