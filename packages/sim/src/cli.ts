import { type TierName } from "@pda/content";
import { BOTS, getBot } from "./bots";
import type { Bot } from "./bots/types";
import { formatComparison, formatReport } from "./format";
import { runFights, type LoadoutName } from "./report";

export interface ParsedArgs {
  command: string;
  options: Record<string, string | true>;
}

/** Splits `fights --bot greedy --n=5 --json` into a command and its options. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { command: "help", options: {} };

  const options: ParsedArgs["options"] = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    const next = rest[i + 1];
    if (inline !== undefined) options[name] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      i++;
    } else options[name] = true;
  }
  return { command: first, options };
}

export interface CliResult {
  code: number;
  output: string;
}

const TIERS: TierName[] = ["minion", "elite", "boss"];
const LOADOUTS: LoadoutName[] = ["starting", "full"];
const MAX_FIGHTS = 1_000_000;

const USAGE = `Usage: pnpm sim <command> [options]

Commands:
  sim fights  --bot <name> [options]    Play many seeded fights with one bot and report the results.
  sim compare --bots <a,b,c> [options]  Play the same fights with several bots and compare them.
  sim runs    --bot <name> [options]    Play whole runs. Needs the run loop (Milestone 4), not available yet.

Options:
  --n <count>                      Number of fights (default 1000)
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
export function main(argv: string[]): CliResult {
  try {
    const { command, options } = parseArgs(argv);
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

      case "runs":
        return {
          code: 1,
          output: "`sim runs` plays whole runs (fights, rewards, rest stops and fusions), which needs the run loop from Milestone 4. It does not exist yet. Use `sim fights` for now.",
        };

      default:
        throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return { code: 1, output: error.message };
    throw error;
  }
}
