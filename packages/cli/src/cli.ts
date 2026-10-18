import type { TierName } from "@pda/content";
import type { LoadoutName, SessionOptions } from "@pda/ui-core";

const TIERS: TierName[] = ["minion", "elite", "boss"];
const LOADOUTS: LoadoutName[] = ["starting", "full"];

export const USAGE = `Usage: pnpm cli [options]

Plays one fight, or with --run a whole act: five fights, a rest stop, an Elite and the Boss, with a reward after each fight.

Options:
  --run                          Play a whole act instead of a single fight
  --record <file>                With --run, save a replay of the run to this file when it ends
  --seed <text>                  Seed for the fight; the same seed gives the same enemy and stream (default: random)
  --tier minion|elite|boss       Enemy tier of a single fight (default minion)
  --loadout starting|full        Structures you own in a single fight (default starting)
  --help                         Show this message`;

export type ParsedGameArgs =
  | { ok: true; mode: "fight"; options: SessionOptions }
  | { ok: true; mode: "run"; options: { seed: string; record?: string } }
  | { ok: false; message: string };

/** Reads the command line. `defaultSeed` is only used when no seed is given, so callers choose where it comes from. */
export function parseGameArgs(argv: string[], { defaultSeed }: { defaultSeed: string }): ParsedGameArgs {
  const fail = (message: string): ParsedGameArgs => ({ ok: false, message });
  const values: Record<string, string> = {};
  let run = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--help" || token === "-h") return fail(USAGE);
    if (!token.startsWith("--")) return fail(`Unexpected "${token}".\n\n${USAGE}`);
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    if (name === "run") {
      run = true;
      continue;
    }
    if (!["seed", "tier", "loadout", "record"].includes(name)) return fail(`Unknown option --${name}.\n\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) return fail(`--${name} needs a value.`);
    values[name] = value;
  }

  if (run) {
    if (values.tier !== undefined || values.loadout !== undefined) return fail("--tier and --loadout are for single fights. A run chooses its own enemies and structures.");
    return { ok: true, mode: "run", options: { seed: values.seed ?? defaultSeed, ...(values.record !== undefined ? { record: values.record } : {}) } };
  }
  if (values.record !== undefined) return fail("--record is for whole runs. Use it with --run.");

  const tier = values.tier ?? "minion";
  if (!(TIERS as string[]).includes(tier)) return fail(`--tier must be one of ${TIERS.join(", ")}.`);
  const loadout = values.loadout ?? "starting";
  if (!(LOADOUTS as string[]).includes(loadout)) return fail(`--loadout must be one of ${LOADOUTS.join(", ")}.`);
  return { ok: true, mode: "fight", options: { seed: values.seed ?? defaultSeed, tier: tier as TierName, loadout: loadout as LoadoutName } };
}
