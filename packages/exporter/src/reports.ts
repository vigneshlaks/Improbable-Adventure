import { structures } from "@pda/content";
import type { StructureKind } from "@pda/engine";
import { productionBits, type ProfileEntry, type RunAnalysis } from "./analysis";
import { CATALOG, type Row } from "./catalog";
import { number, pct, size } from "./format";
import type { SizingConstants, Workload } from "./sizing";
import { hasTemplate, type Language } from "./toolkit";

const ANSWERS: Record<string, string> = { presence: "have I seen this?", frequency: "how many times?", count: "how many different?" };
export function readme(language: Language, owned: readonly StructureKind[]): string {
  const rows = owned.filter(hasTemplate).map((kind) => {
    const info = structures[kind];
    const entry = CATALOG[kind] as NonNullable<(typeof CATALOG)[StructureKind]>;
    const guide = entry.guide;
    const code = { cls: entry.cls, file: { typescript: `src/${entry.typescript}.ts`, python: `src/${entry.python}.py` } };
    const answers = info.answers.map((a) => ANSWERS[a]).join(" / ");
    return `### ${info.name}\n\n${info.summary}\n\n- Answers: ${answers}\n- Use it when: ${guide.use}\n- Avoid it when: ${guide.avoid}\n- Code: \`${code.file[language]}\` (\`${code.cls}\`)\n`;
  });
  const without = owned.filter((kind) => !hasTemplate(kind));
  const run =
    language === "typescript"
      ? "Needs Node 22.18 or later, and nothing to install.\n\n```\nnode --test \"tests/*.test.ts\"\n```"
      : "Needs Python 3.9 or later and `pytest`.\n\n```\npip install pytest\npython -m pytest\n```";
  return `# Probabilistic data structures toolkit

Reference code for the structures you used in your run, with tests, plus a sizing calculator for your real workload.
The code is small and plain on purpose: read it, copy it, or use it as the check for a production library.

Start with \`SIZING.md\`: it says how big each structure should be for your workload, and what error that gives.
\`FIELD_REPORT.md\` is the story of your run.

## What is in here

${rows.join("\n")}${without.length > 0 ? `\n### Used in your run, with no reference code yet\n\n${without.map((kind) => `- ${structures[kind].name}: ${structures[kind].summary}`).join("\n")}\n\nThey are in \`FIELD_REPORT.md\`; the toolkit has no code or sizing for them yet.\n` : ""}
## Using a structure

Every structure takes a seed (the default is public, so pass your own secret one if inputs may be chosen by an attacker),
and items are integers from 0 to 2^32 - 1, strings or bytes. Parameters come from the sizing calculator, \`${language === "typescript" ? "sizing.ts" : "sizing.py"}\`.
Numbers you used in the game (Space, depth, expected items) were tuned for tension, not for production: do not copy them.

## Running the tests

${run}

The tests include statistical checks: each structure is run over hundreds of seeded random streams and must stay within its stated error.
They also replay known answers from the reference implementation (\`tests/vectors.json\`), so the TypeScript and Python versions agree exactly.
`;
}

interface Resolved {
  workload: Workload;
  notes: string[];
}

/** Fills in what the player left blank, saying so: the distinct count may be at most the item count, and the other way round. */
export function resolveWorkload(workload: Workload): Resolved {
  const notes: string[] = [];
  const resolved: Workload = { ...workload };
  if (resolved.distinct === undefined && resolved.items !== undefined) {
    resolved.distinct = resolved.items;
    notes.push("The number of different items was not given, so the item count is used (the worst case).");
  }
  if (resolved.items === undefined && resolved.distinct !== undefined) {
    resolved.items = resolved.distinct;
    notes.push("The item count was not given, so the distinct count is used.");
  }
  if (resolved.error === undefined && resolved.memoryBits === undefined) notes.push("No acceptable error was given, so the default of 1% is used.");
  return { workload: resolved, notes };
}

function snippet(language: Language, kind: StructureKind, args: Record<string, number>): string {
  const entry = CATALOG[kind];
  const values = (entry?.args ?? []).map((name) => number(args[name] as number).replace(/,/g, ""));
  const cls = entry?.cls ?? kind;
  return language === "typescript" ? `new ${cls}(${values.join(", ")})` : `${cls}(${values.join(", ")})`;
}

/** Sizes one structure for a workload, or says what is missing. */
function sizeFor(kind: StructureKind, workload: Workload, constants: SizingConstants): Row | string {
  const entry = CATALOG[kind];
  if (!entry) return "There is no sizing rule for this structure yet.";
  try {
    return entry.size(workload, constants);
  } catch (error) {
    return error instanceof RangeError ? `Cannot be sized: ${error.message}.` : "Cannot be sized.";
  }
}

export function sizingReport(language: Language, owned: readonly StructureKind[], input: Workload, profile: ProfileEntry[], constants: SizingConstants): string {
  const { workload, notes } = resolveWorkload(input);
  const given = (value: number | undefined, text: (v: number) => string) => (value === undefined ? "not given" : text(value));
  const sections = owned.filter(hasTemplate).map((kind) => {
    const info = structures[kind];
    const lines: string[] = [`## ${info.name}`, ""];
    const sized = sizeFor(kind, workload, constants);
    if (typeof sized === "string") lines.push(sized);
    else {
      lines.push(`- **Size it:** ${sized.summary[0]}.`, `- **Result:** ${sized.summary[1]}.`, `- **Construct it:** \`${snippet(language, kind, sized.args)}\``);
      const mine = profile.find((entry) => entry.kind === kind);
      if (mine && workload.items !== undefined) {
        const budget = productionBits(kind, workload, constants) ?? 0;
        const style = mine.spaceRatio < 1 ? "tighter than" : "roomier than";
        lines.push(`- **Your run's style:** you gave it about ${mine.spaceRatio.toFixed(2)} times the Space that the default ${pct(constants.defaultError)} target needs for the same stream, ${style} production sizing. Run that way on your workload it would take about ${size(mine.spaceRatio * budget)}.`);
      }
    }
    lines.push("", `Formula: ${(CATALOG[kind] as NonNullable<(typeof CATALOG)[StructureKind]>).formula(constants)}`, "");
    return lines.join("\n");
  });
  return `# Sizing

Parameters below are computed from your workload, not copied from the game: the game's Space was deliberately tight.

| Your workload | |
| --- | --- |
| Items added (with repeats) | ${given(input.items, number)} |
| Different items | ${given(input.distinct, number)} |
| Acceptable error | ${given(input.error, pct)} |
| Memory budget | ${given(input.memoryBits, size)} |

${[...notes, ...(input.memoryBits !== undefined ? ["A memory budget was given, so each structure uses it and reports the error that gives; the target error is only checked against it."] : [])].map((note) => `- ${note}\n`).join("")}
Change the workload by calling the calculator in \`${language === "typescript" ? "sizing.ts" : "sizing.py"}\`: it takes items, distinct, error and memory (any may be left out) and returns the parameters.

${sections.join("\n")}`;
}

const TIER_NAME = { minion: "Minion", elite: "Elite", boss: "Boss" } as const;

export function fieldReport(analysis: RunAnalysis, profile: ProfileEntry[], constants: SizingConstants): string {
  const result = analysis.won ? `Won in ${analysis.turns} turns with ${Math.round(analysis.certaintyLeft)} Certainty left.` : `Lost in fight ${analysis.fights.length} after ${analysis.turns} turns.`;
  const byStructure = analysis.used.map((kind) => {
    const withIt = analysis.fights.filter((fight) => fight.deployed.includes(kind));
    const won = withIt.filter((fight) => fight.won).length;
    const mine = profile.find((entry) => entry.kind === kind);
    return `| ${structures[kind].name} | ${withIt.length} | ${won} | ${mine ? size(mine.meanSpaceBits) : "never deployed"} | ${mine ? mine.spaceRatio.toFixed(2) : ""} |`;
  });
  const fights = analysis.fights.map((fight) => {
    const traits = Object.entries(fight.traits).filter(([, level]) => level !== "low").map(([name, level]) => `${name} ${level}`).join(", ") || "none";
    return `| ${fight.number} | ${TIER_NAME[fight.tier]} | ${traits} | ${fight.won ? "won" : "lost"} in ${fight.turns} | ${fight.deployed.map((kind) => structures[kind].name).join(", ") || "none"} |`;
  });
  const strikes = analysis.fights.flatMap((fight) => fight.strikes.map((strike) => ({ fight: fight.number, ...strike })));
  const kinds = (["presence", "frequency", "count"] as const).map((kind) => {
    const mine = strikes.filter((strike) => strike.kind === kind);
    return mine.length === 0 ? null : `| ${kind[0]?.toUpperCase()}${kind.slice(1)} | ${mine.length} | ${mine.filter((strike) => strike.good).length} |`;
  });
  const mistakes = strikes.filter((strike) => !strike.good);
  return `# Field report

Seed \`${analysis.seed}\`. ${result}

## Your structures

| Structure | Fights deployed | Of those won | Mean Space | Space vs production sizing |
| --- | --- | --- | --- | --- |
${byStructure.join("\n")}

"Space vs production sizing" is the Space you gave, divided by what the sizing calculator asks for the same stream at a ${pct(constants.defaultError)} target: below 1 means you ran it tighter than you would in production, and accepted more error for it.

## Enemies met

| Fight | Tier | Stream traits above low | Result | Structures deployed |
| --- | --- | --- | --- | --- |
${fights.join("\n")}

## Strikes

| Question | Strikes | Sound |
| --- | --- | --- |
${kinds.filter(Boolean).join("\n")}

## Mistakes

${mistakes.length === 0 ? "None: every strike was sound." : mistakes.slice(0, 12).map((strike) => `- Fight ${strike.fight}, ${strike.kind}: ${strike.text}`).join("\n")}${mistakes.length > 12 ? `\n- ...and ${mistakes.length - 12} more.` : ""}
`;
}
