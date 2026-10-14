import { describe, expect, it } from "vitest";
import { parseGameArgs } from "./cli";

describe("parseGameArgs", () => {
  const defaults = { defaultSeed: "clock" };

  it("uses Minion, the starting loadout and the given default seed", () => {
    expect(parseGameArgs([], defaults)).toEqual({ ok: true, options: { seed: "clock", tier: "minion", loadout: "starting" } });
  });

  it("reads --seed, --tier and --loadout in both spellings", () => {
    expect(parseGameArgs(["--seed", "abc", "--tier=boss", "--loadout", "full"], defaults)).toEqual({
      ok: true,
      options: { seed: "abc", tier: "boss", loadout: "full" },
    });
  });

  it("explains a bad value or an unknown option", () => {
    expect(parseGameArgs(["--tier", "dragon"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--tier must be one of minion, elite, boss/) });
    expect(parseGameArgs(["--loadout", "everything"], defaults)).toMatchObject({ ok: false });
    expect(parseGameArgs(["--colour", "red"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/Unknown option --colour/) });
    expect(parseGameArgs(["--seed"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/--seed needs a value/) });
  });

  it("shows usage for --help", () => {
    expect(parseGameArgs(["--help"], defaults)).toMatchObject({ ok: false, message: expect.stringMatching(/Usage: pnpm cli/) });
  });
});
