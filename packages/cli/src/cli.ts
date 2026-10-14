import type { TierName } from "@pda/content";
import type { LoadoutName, SessionOptions } from "./session";

const TIERS: TierName[] = ["minion", "elite", "boss"];
const LOADOUTS: LoadoutName[] = ["starting", "full"];

export const USAGE = `Usage: pnpm cli [options]

Options:
  --seed <text>                  Seed for the fight; the same seed gives the same enemy and stream (default: random)
  --tier minion|elite|boss       Enemy tier (default minion)
  --loadout starting|full        Structures you own (default starting)
  --help                         Show this message`;

export type ParsedGameArgs = { ok: true; options: SessionOptions } | { ok: false; message: string };

/** Reads the command line. `defaultSeed` is only used when no seed is given, so callers choose where it comes from. */
export function parseGameArgs(argv: string[], { defaultSeed }: { defaultSeed: string }): ParsedGameArgs {
  const fail = (message: string): ParsedGameArgs => ({ ok: false, message });
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--help" || token === "-h") return fail(USAGE);
    if (!token.startsWith("--")) return fail(`Unexpected "${token}".\n\n${USAGE}`);
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    if (!["seed", "tier", "loadout"].includes(name)) return fail(`Unknown option --${name}.\n\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) return fail(`--${name} needs a value.`);
    values[name] = value;
  }

  const tier = values.tier ?? "minion";
  if (!(TIERS as string[]).includes(tier)) return fail(`--tier must be one of ${TIERS.join(", ")}.`);
  const loadout = values.loadout ?? "starting";
  if (!(LOADOUTS as string[]).includes(loadout)) return fail(`--loadout must be one of ${LOADOUTS.join(", ")}.`);
  return { ok: true, options: { seed: values.seed ?? defaultSeed, tier: tier as TierName, loadout: loadout as LoadoutName } };
}
