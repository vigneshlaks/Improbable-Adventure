import type { Replay } from "@pda/engine";
import { analyzeRun, tradeoffProfile } from "./analysis";
import { fieldReport, readme, sizingReport } from "./reports";
import type { SizingConstants, Workload } from "./sizing";
import { generateToolkit, type Language, type TemplateSet } from "./toolkit";

export interface ExportInput {
  language: Language;
  /** A finished run, verified by the caller. */
  replay: Replay;
  /** What the player knows about their real workload; every field may be blank. */
  workload: Workload;
  templates: TemplateSet;
  constants: SizingConstants;
}

/**
 * Everything in the toolkit, as path to contents: the code and tests for the structures the run ended with, and the
 * three documents written from the player's workload and run.
 */
export function buildToolkit({ language, replay, workload, templates, constants }: ExportInput): Record<string, string> {
  const analysis = analyzeRun(replay);
  const profile = tradeoffProfile(analysis, constants);
  return {
    ...generateToolkit(language, analysis.used, templates),
    "README.md": readme(language, analysis.used),
    "SIZING.md": sizingReport(language, analysis.used, workload, profile, constants),
    "FIELD_REPORT.md": fieldReport(analysis, profile, constants),
  };
}
