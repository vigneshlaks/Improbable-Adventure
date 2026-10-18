import { describe, expect, it } from "vitest";
import { parseGameArgs } from "./cli";

describe("parseGameArgs", () => {
  const defaults = { defaultSeed: "clock" };

  it("uses Minion, the starting loadout and the given default seed; reads --seed, --tier and --loadout in both spellings; plays a whole run with --run, using the seed and nothing else; and 2 more", () => {
    // uses Minion, the starting loadout and the given default seed
    {
      expect(parseGameArgs([], defaults)).toEqual({ ok: true, mode: "fight", options: { seed: "clock", tier: "minion", loadout: "starting" } });
    }
    // reads --seed, --tier and --loadout in both spellings
    {
      expect(parseGameArgs(["--seed", "abc", "--tier=boss", "--loadout", "full"], defaults)).toEqual({
        ok: true,
        mode: "fight",
        options: { seed: "abc", tier: "boss", loadout: "full" },
      });
    }
    // plays a whole run with --run, using the seed and nothing else
    {
      expect(parseGameArgs(["--run"], defaults)).toEqual({ ok: true, mode: "run", options: { seed: "clock" } });
      expect(parseGameArgs(["--run", "--seed", "abc"], defaults)).toEqual({ ok: true, mode: "run", options: { seed: "abc" } });
      expect(parseGameArgs(["--seed=abc", "--run"], defaults)).toEqual({ ok: true, mode: "run", options: { seed: "abc" } });
      expect(parseGameArgs(["--run", "--record", "out.json"], defaults)).toEqual({ ok: true, mode: "run", options: { seed: "clock", record: "out.json" } });
      expect(parseGameArgs(["--record=out.json", "--run", "--seed", "abc"], defaults)).toEqual({ ok: true, mode: "run", options: { seed: "abc", record: "out.json" } });
      expect(parseGameArgs(["--record", "out.json"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--record is for whole runs/) });
      expect(parseGameArgs(["--run", "--tier", "boss"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--tier and --loadout are for single fights/) });
      expect(parseGameArgs(["--run", "--loadout=full"], defaults)).toMatchObject({ ok: false });
    }
    // explains a bad value or an unknown option
    {
      expect(parseGameArgs(["--tier", "dragon"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--tier must be one of minion, elite, boss/) });
      expect(parseGameArgs(["--loadout", "everything"], defaults)).toMatchObject({ ok: false });
      expect(parseGameArgs(["--colour", "red"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/Unknown option --colour/) });
      expect(parseGameArgs(["--seed"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--seed needs a value/) });
    }
    // shows usage for --help
    {
      expect(parseGameArgs(["--help"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/Usage: pnpm cli/) });
      expect(parseGameArgs(["--help"], defaults)).toMatchObject({ message: expect.stringMatching(/--run/) });
    }
  });
});
