import { structures } from "@pda/content";
import type { StructureKind } from "@pda/engine";
import { productionBits, type ProfileEntry, type RunAnalysis } from "./analysis";
import { sizeBloom, sizeCountMin, sizeExact, sizeHyperLogLog, sizeLinearCounting, sizeLogLog, sizeReservoir, type SizingConstants, type Workload } from "./sizing";
import type { Language } from "./toolkit";

/** When each structure is the right tool, and when it is not. Written for production, not for the game. */
const GUIDE: Record<StructureKind, { use: string; avoid: string }> = {
  exactMemory: { use: "The set of different items is small enough to store (thousands to a few million), or you need a ground truth to test the others against.", avoid: "Memory must stay fixed while the number of different items grows." },
  reservoirSampling: { use: "You need a fair random sample of a stream of unknown length, to estimate shares or to look at real examples.", avoid: "You need exact counts of rare items; a sample misses them." },
  bloomFilter: { use: "You ask \"have I seen this?\" and can tolerate occasional false yeses but never false nos (cache and database lookups, deduplication).", avoid: "Items must be removed, or a false yes is costly with no way to check." },
  countMinSketch: { use: "You need approximate counts per item (heavy hitters, rate limiting) in fixed memory.", avoid: "You need exact counts, or most items are rare: its overshoot is a fixed share of the total, which swamps small counts." },
  linearCounting: { use: "You count different items and the count is small or roughly known in advance, so a bit array can be sized for it.", avoid: "The count can grow far past the bit array: it saturates and then only gives a lower limit." },
  logLog: { use: "You count different items with tiny memory and want the simplest arithmetic.", avoid: "You can use HyperLogLog, which needs fewer registers for the same error." },
  hyperLogLog: { use: "You count different items, possibly billions, in kilobytes, and can accept an error of a percent or two. Counters can be merged across machines.", avoid: "You need an exact count, or the count is small enough to store exactly." },
};

const CONSTRUCTORS: Record<StructureKind, { file: Record<Language, string>; cls: string }> = {
  exactMemory: { cls: "ExactMemory", file: { typescript: "src/exactMemory.ts", python: "src/exact_memory.py" } },
  reservoirSampling: { cls: "ReservoirSampling", file: { typescript: "src/reservoirSampling.ts", python: "src/reservoir_sampling.py" } },
  bloomFilter: { cls: "BloomFilter", file: { typescript: "src/bloomFilter.ts", python: "src/bloom_filter.py" } },
  countMinSketch: { cls: "CountMinSketch", file: { typescript: "src/countMinSketch.ts", python: "src/count_min_sketch.py" } },
  linearCounting: { cls: "LinearCounting", file: { typescript: "src/linearCounting.ts", python: "src/linear_counting.py" } },
  logLog: { cls: "LogLog", file: { typescript: "src/logLog.ts", python: "src/log_log.py" } },
  hyperLogLog: { cls: "HyperLogLog", file: { typescript: "src/hyperLogLog.ts", python: "src/hyper_log_log.py" } },
};

const ANSWERS: Record<string, string> = { presence: "have I seen this?", frequency: "how many times?", count: "how many different?" };
const pct = (x: number) => (x < 0.001 ? `${(x * 100).toPrecision(2)}%` : `${Math.round(x * 1000) / 10}%`);
const number = (x: number) => Math.round(x).toLocaleString("en-US");

function size(bits: number): string {
  if (bits < 8 * 1024) return `${number(bits)} bits`;
  const bytes = bits / 8;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function readme(language: Language, owned: readonly StructureKind[]): string {
  const rows = owned.map((kind) => {
    const info = structures[kind];
    const answers = info.answers.map((a) => ANSWERS[a]).join(" / ");
    return `### ${info.name}\n\n${info.summary}\n\n- Answers: ${answers}\n- Use it when: ${GUIDE[kind].use}\n- Avoid it when: ${GUIDE[kind].avoid}\n- Code: \`${CONSTRUCTORS[kind].file[language]}\` (\`${CONSTRUCTORS[kind].cls}\`)\n`;
  });
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

${rows.join("\n")}
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
  const names: Record<StructureKind, string[]> = {
    exactMemory: [],
    reservoirSampling: ["sampleSize"],
    bloomFilter: ["bits", "hashes"],
    countMinSketch: ["width", "depth"],
    linearCounting: ["bits"],
    logLog: ["indexBits"],
    hyperLogLog: ["indexBits"],
  };
  const values = names[kind].map((name) => number(args[name] as number).replace(/,/g, ""));
  const cls = CONSTRUCTORS[kind].cls;
  return language === "typescript" ? `new ${cls}(${values.join(", ")})` : `${cls}(${values.join(", ")})`;
}

interface Row {
  summary: string[];
  args: Record<string, number>;
  bits: number;
}

/** Sizes one structure for a workload, or says what is missing. */
function sizeFor(kind: StructureKind, workload: Workload, constants: SizingConstants): Row | string {
  const need = (field: keyof Workload, label: string) => (workload[field] === undefined ? label : null);
  try {
    switch (kind) {
      case "bloomFilter": {
        const missing = need("items", "the item count");
        if (missing) return `Needs ${missing}.`;
        const s = sizeBloom(workload, constants);
        return { bits: s.memoryBits, args: { bits: s.bits, hashes: s.hashes }, summary: [`${number(s.bits)} bits (${size(s.bits)}) and ${s.hashes} hashes`, `false-positive rate ${pct(s.falsePositiveRate)}`] };
      }
      case "countMinSketch": {
        const s = sizeCountMin(workload, constants);
        return { bits: s.memoryBits, args: { width: s.width, depth: s.depth }, summary: [`${number(s.width)} columns by ${s.depth} rows (${size(s.memoryBits)})`, `an estimate overshoots by at most ${pct(s.errorShare)} of all items added${workload.items ? ` (about ${number(s.overshoot)} for ${number(workload.items)} items)` : ""}, with probability ${pct(s.confidence)}`] };
      }
      case "hyperLogLog":
      case "logLog": {
        const s = (kind === "hyperLogLog" ? sizeHyperLogLog : sizeLogLog)(workload, constants);
        return { bits: s.memoryBits, args: { indexBits: s.indexBits }, summary: [`${number(s.registers)} registers (index bits ${s.indexBits}, ${size(s.memoryBits)})`, `standard error ${pct(s.standardError)}`] };
      }
      case "linearCounting": {
        const missing = need("distinct", "the number of different items");
        if (missing) return `Needs ${missing}.`;
        const s = sizeLinearCounting(workload, constants);
        return { bits: s.memoryBits, args: { bits: s.bits }, summary: [`${number(s.bits)} bits (${size(s.bits)})`, `standard error ${pct(s.standardError)} at ${number(workload.distinct as number)} different items; it saturates well above that`] };
      }
      case "reservoirSampling": {
        const s = sizeReservoir(workload, constants);
        return { bits: s.memoryBits, args: { sampleSize: s.sampleSize }, summary: [`a sample of ${number(s.sampleSize)} items (${size(s.memoryBits)})`, `a share estimated from it is within ${pct(s.error)} of the truth at ${pct(constants.confidence)} confidence`] };
      }
      case "exactMemory": {
        const missing = need("distinct", "the number of different items");
        if (missing) return `Needs ${missing}.`;
        const s = sizeExact(workload, constants);
        return { bits: s.memoryBits, args: {}, summary: [`${number(s.entries)} entries (${size(s.memoryBits)}) at ${constants.valueBits + constants.counterBits} bits each`, "no error at all"] };
      }
    }
  } catch (error) {
    return error instanceof RangeError ? `Cannot be sized: ${error.message}.` : "Cannot be sized.";
  }
}

export function sizingReport(language: Language, owned: readonly StructureKind[], input: Workload, profile: ProfileEntry[], constants: SizingConstants): string {
  const { workload, notes } = resolveWorkload(input);
  const given = (value: number | undefined, text: (v: number) => string) => (value === undefined ? "not given" : text(value));
  const formula = formulas(constants);
  const sections = owned.map((kind) => {
    const info = structures[kind];
    const lines: string[] = [`## ${info.name}`, ""];
    const sized = sizeFor(kind, workload, constants);
    if (typeof sized === "string") lines.push(sized);
    else {
      lines.push(`- **Size it:** ${sized.summary[0]}.`, `- **Result:** ${sized.summary[1]}.`, `- **Construct it:** \`${snippet(language, kind, sized.args)}\``);
      const mine = profile.find((entry) => entry.kind === kind);
      if (mine && workload.items !== undefined) {
        const budget = productionBits(kind, workload, constants);
        const style = mine.spaceRatio < 1 ? "tighter than" : "roomier than";
        lines.push(`- **Your run's style:** you gave it about ${mine.spaceRatio.toFixed(2)} times the Space that the default ${pct(constants.defaultError)} target needs for the same stream, ${style} production sizing. Run that way on your workload it would take about ${size(mine.spaceRatio * budget)}.`);
      }
    }
    lines.push("", `Formula: ${formula[kind]}`, "");
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

function formulas(c: SizingConstants): Record<StructureKind, string> {
  const z = (confidenceZ: number) => confidenceZ.toFixed(2);
  return {
    exactMemory: `bits = distinct x (${c.valueBits} + ${c.counterBits}).`,
    reservoirSampling: `sample size = z^2 x 0.25 / error^2, with z = ${z(1.96)} at ${pct(c.confidence)} confidence (the worst case, a share of one half).`,
    bloomFilter: "bits m = -n ln(p) / (ln 2)^2; hashes k = round(m / n x ln 2); false-positive rate p = (1 - e^(-k n / m))^k. The size is raised until the rate with a whole number of hashes meets the target.",
    countMinSketch: `width w = ceil(e / error); depth d = ceil(ln(1 / (1 - confidence))); bits = ${c.counterBits} x w x d. An estimate never underestimates and overshoots by at most (e / w) x N with probability 1 - e^(-d).`,
    linearCounting: "standard error = sqrt(m (e^t - t - 1)) / n with t = n / m; the smallest m that meets the target is found by search.",
    logLog: `registers m = 2^ceil(log2((${c.logLogErrorCoefficient} / error)^2)); bits = ${c.registerBits} x m; standard error = ${c.logLogErrorCoefficient} / sqrt(m).`,
    hyperLogLog: `registers m = 2^ceil(log2((${c.hyperLogLogErrorCoefficient} / error)^2)); bits = ${c.registerBits} x m; standard error = ${c.hyperLogLogErrorCoefficient} / sqrt(m).`,
  };
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
