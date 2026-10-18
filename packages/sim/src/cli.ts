import { type TierName } from "@pda/content";
import { BOTS, getBot } from "./bots";
import type { Bot } from "./bots/types";
import { formatComparison, formatReport } from "./format";
import { runFights, type LoadoutName } from "./report";
import { formatRunComparison, formatRunReport } from "./runFormat";
import { checkTargets, runBatch } from "./runReport";
import { recordReplay } from "./replayRecorder";
import { contentHash } from "@pda/content";
import { rankSpeedruns, verifyReplay, type Replay, type VerifyResult } from "@pda/engine";

export interface ParsedArgs {
  command: string;
  options: Record<string, string | true>;
  /** The words after the command that are not options, such as `verify` and the file names of `replay verify`. */
  positional: string[];
}

/** Splits `fights --bot greedy --n=5 --json` into a command and its options. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { command: "help", options: {}, positional: [] };

  const options: ParsedArgs["options"] = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    const next = rest[i + 1];
    if (inline !== undefined) options[name] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      i++;
    } else options[name] = true;
  }
  return { command: first, options, positional };
}

export interface CliResult {
  code: number;
  output: string;
  /** Files the caller should write, so that `main` does no I/O itself. */
  files?: Array<{ path: string; content: string }>;
}

/** What `main` may ask its caller to do. Reading a file is the only thing it needs. */
export interface CliIo {
  readText?: (path: string) => string;
}

const TIERS: TierName[] = ["minion", "elite", "boss"];
const LOADOUTS: LoadoutName[] = ["starting", "full"];
const MAX_FIGHTS = 1_000_000;
const MAX_RUNS = 100_000;

const USAGE = `Usage: pnpm sim <command> [options]

Commands:
  sim fights  --bot <name> [options]    Play many seeded fights with one bot and report the results.
  sim compare --bots <a,b,c> [options]  Play the same fights with several bots and compare them.
  sim runs    --bot <name> [options]    Play whole runs (five fights, a rest stop, an Elite and the Boss) and check the spec's targets.
  sim runs    --bots <a,b,c> [options]  Play the same runs with several bots and compare them.
  sim replay record --bot <name> --seed <text> [--out <file>]  Play a whole run and save it as a replay.
  sim replay verify <file...>               Re-play replays and check what they claim. Exits 1 if any is rejected.
  sim replay rank <file...>                 Verify replays and rank the won ones by speed (fewest turns, then most Certainty left).

Options:
  --n <count>                      Number of fights (default 1000), or of runs (default 100)
  --seed-base <number>             First seed; fight i uses seed-base + i (default 1)
  --tier minion|elite|boss         Enemy tier (default minion)
  --loadout starting|full          Structures the bot may deploy (default starting)
  --json                           Print JSON instead of text

Bots: ${Object.keys(BOTS).join(", ")}`;

class UsageError extends Error {}

const wholeNumber = (value: string | true | undefined, fallback: number, min: number, max: number, name: string): number => {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
};

const oneOf = <T extends string>(value: string | true | undefined, choices: readonly T[], fallback: T, name: string): T => {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} must be one of ${choices.join(", ")}.`);
};

function lookupBot(name: string): Bot {
  try {
    return getBot(name);
  } catch {
    throw new UsageError(`Unknown bot "${name}". Choose one of: ${Object.keys(BOTS).join(", ")}.`);
  }
}

function rejectUnknownOptions(options: ParsedArgs["options"], allowed: string[]): void {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new UsageError(`Unknown option --${name}. Valid options: ${allowed.map((o) => `--${o}`).join(", ")}.`);
  }
}

/** Runs one command line and returns what to print and the exit code. Never prints or exits itself. */
export function main(argv: string[], io: CliIo = {}): CliResult {
  try {
    const { command, options, positional } = parseArgs(argv);
    const common = ["n", "seed-base", "tier", "loadout", "json"];
    const settings = () => ({
      n: wholeNumber(options.n, 1000, 1, MAX_FIGHTS, "n"),
      seedBase: wholeNumber(options["seed-base"], 1, 0, Number.MAX_SAFE_INTEGER, "seed-base"),
      tier: oneOf(options.tier, TIERS, "minion", "tier"),
      loadout: oneOf(options.loadout, LOADOUTS, "starting", "loadout"),
    });

    switch (command) {
      case "help":
        return { code: 0, output: USAGE };

      case "fights": {
        rejectUnknownOptions(options, ["bot", ...common]);
        if (typeof options.bot !== "string") throw new UsageError(`Missing --bot. Choose one of: ${Object.keys(BOTS).join(", ")}.`);
        const report = runFights({ bot: lookupBot(options.bot), ...settings() });
        return { code: 0, output: options.json ? JSON.stringify(report, null, 2) : formatReport(report) };
      }

      case "compare": {
        rejectUnknownOptions(options, ["bots", ...common]);
        if (typeof options.bots !== "string") throw new UsageError(`Missing --bots, for example --bots greedy,prober,cautious.`);
        const bots = options.bots.split(",").map((name) => lookupBot(name.trim()));
        const reports = bots.map((bot) => runFights({ bot, ...settings() }));
        return { code: 0, output: options.json ? JSON.stringify(reports, null, 2) : formatComparison(reports) };
      }

      case "runs": {
        rejectUnknownOptions(options, ["bot", "bots", "n", "seed-base", "json"]);
        if (typeof options.bot === "string" && typeof options.bots === "string") throw new UsageError("Use --bot or --bots, not both.");
        const names = typeof options.bot === "string" ? [options.bot] : typeof options.bots === "string" ? options.bots.split(",").map((name) => name.trim()) : [];
        if (names.length === 0) throw new UsageError(`Missing --bot or --bots. Choose from: ${Object.keys(BOTS).join(", ")}.`);
        for (const name of names) lookupBot(name);
        const n = wholeNumber(options.n, 100, 1, MAX_RUNS, "n");
        const seedBase = wholeNumber(options["seed-base"], 1, 0, Number.MAX_SAFE_INTEGER, "seed-base");
        const reports = names.map((botName) => runBatch({ botName, n, seedBase }));
        const checks = checkTargets(reports);
        if (options.json) return { code: 0, output: JSON.stringify({ reports, targets: checks }, null, 2) };
        const single = reports.length === 1 ? formatRunReport(reports[0] as (typeof reports)[number], checks) : null;
        const targets = checks.map((check) => `  ${check.ok ? "met   " : "missed"}  ${check.target}: ${check.detail}`);
        return { code: 0, output: single ?? [formatRunComparison(reports), "", "Spec targets", ...targets].join("\n") };
      }

      case "replay":
        return replayCommand(positional, options, io);

      default:
        throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return { code: 1, output: error.message };
    throw error;
  }
}

/** Reads, parses and verifies one replay file. Never throws. */
function checkFile(path: string, io: CliIo): { path: string; replay: Replay | null; result: VerifyResult } {
  let text: string;
  try {
    if (!io.readText) throw new Error("Reading files is not available here");
    text = io.readText(path);
  } catch (error) {
    return { path, replay: null, result: { ok: false, reason: "malformed", message: error instanceof Error ? error.message : "The file cannot be read" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path, replay: null, result: { ok: false, reason: "malformed", message: "The file is not valid JSON" } };
  }
  return { path, replay: parsed as Replay, result: verifyReplay(parsed) };
}

function replayCommand(positional: string[], options: ParsedArgs["options"], io: CliIo): CliResult {
  const [sub, ...rest] = positional;
  if (sub === undefined) throw new UsageError("Use sim replay record, verify or rank.");

  if (sub === "record") {
    rejectUnknownOptions(options, ["bot", "seed", "out"]);
    if (typeof options.bot !== "string") throw new UsageError(`Missing --bot. Choose one of: ${Object.keys(BOTS).join(", ")}.`);
    const bot = lookupBot(options.bot);
    const seed = typeof options.seed === "string" ? options.seed : "1";
    let replay: Replay;
    try {
      replay = recordReplay({ bot, seed });
    } catch (error) {
      return { code: 1, output: `Could not record: ${error instanceof Error ? error.message : String(error)}` };
    }
    const { won, turns, certaintyLeft } = replay.claimed;
    const summary = `Recorded ${bot.name} on seed ${seed}: ${won ? "won" : "lost"} in ${turns} turns with ${certaintyLeft} Certainty left, ${replay.actions.length} actions.`;
    return typeof options.out === "string"
      ? { code: 0, output: `${summary}\nWrote ${options.out}.`, files: [{ path: options.out, content: JSON.stringify(replay) }] }
      : { code: 0, output: summary };
  }

  if (sub === "verify" || sub === "rank") {
    rejectUnknownOptions(options, []);
    if (rest.length === 0) throw new UsageError(`sim replay ${sub} needs at least one file.`);
    const checked = rest.map((path) => checkFile(path, io));
    const current = contentHash();
    const line = (entry: (typeof checked)[number]): string => {
      if (!entry.result.ok) return `REJECTED ${entry.path}: ${entry.result.reason}. ${entry.result.message}`;
      const { won, turns, certaintyLeft } = entry.result.result;
      const stale = entry.replay && entry.replay.contentHash !== current ? " (recorded with other content than the current)" : "";
      return `ok ${entry.path}: ${won ? "won" : "lost"} in ${turns} turns with ${certaintyLeft} Certainty left${stale}`;
    };
    const rejected = checked.filter((entry) => !entry.result.ok);
    if (sub === "verify") return { code: rejected.length > 0 ? 1 : 0, output: checked.map(line).join("\n") };

    const wins = rankSpeedruns(
      checked.flatMap((entry) => (entry.result.ok && entry.replay ? [{ ...entry, claimed: entry.result.result }] : [])),
    );
    const seeds = new Set(wins.map((entry) => entry.replay?.seed));
    const category = seeds.size === 1 ? `Fixed Seed ${[...seeds][0]}` : "Random Seed";
    const lines = [
      `Speedrun ranking, ${category}: fewest turns, then most Certainty left`,
      ...wins.map((entry, i) => `  ${i + 1}. ${entry.path}: ${entry.claimed.turns} turns, ${entry.claimed.certaintyLeft} Certainty left (seed ${entry.replay?.seed})`),
      ...(wins.length === 0 ? ["  no verified win"] : []),
      ...(checked.length - wins.length > 0
        ? [`Left out: ${checked.filter((entry) => !wins.some((win) => win.path === entry.path)).map((entry) => `${entry.path} (${entry.result.ok ? "not a win" : "rejected"})`).join(", ")}`]
        : []),
    ];
    return { code: 0, output: lines.join("\n") };
  }

  throw new UsageError(`Unknown replay command "${sub}". Use record, verify or rank.`);
}
