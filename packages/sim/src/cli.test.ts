import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { main, parseArgs } from "./cli";

describe("parseArgs", () => {
  it("reads the command and its options, with a space or an equals sign", () => {
    expect(parseArgs(["fights", "--bot", "greedy", "--n=5", "--json"])).toEqual({
      command: "fights",
      options: { bot: "greedy", n: "5", json: true },
    });
  });

  it("treats no arguments as a request for help", () => {
    expect(parseArgs([])).toEqual({ command: "help", options: {} });
  });
});

describe("main", () => {
  it("prints the usage with no arguments or for help", () => {
    for (const argv of [[], ["help"], ["--help"]]) {
      const { code, output } = main(argv);
      expect(code).toBe(0);
      expect(output).toMatch(/sim fights/);
      expect(output).toMatch(/sim compare/);
      expect(output).toMatch(/sim runs/);
    }
  });

  it("runs a batch of fights and prints the report", () => {
    const { code, output } = main(["fights", "--bot", "oracle", "--n", "15", "--seed-base", "3"]);
    expect(code).toBe(0);
    expect(output).toMatch(/oracle/);
    expect(output).toMatch(/15 fights/);
    expect(output).toMatch(/Won +100\.0%/);
  });

  it("can print the report as JSON", () => {
    const { code, output } = main(["fights", "--bot", "oracle", "--n", "10", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ bot: "oracle", fights: 10, winRate: 1, seedBase: 1, tier: "minion", loadout: "starting" });
  });

  it("honours the tier and loadout options", () => {
    const { output } = main(["fights", "--bot", "oracle", "--n", "5", "--tier", "elite", "--loadout", "full", "--json"]);
    expect(JSON.parse(output)).toMatchObject({ tier: "elite", loadout: "full" });
  });

  it("compares bots side by side", () => {
    const { code, output } = main(["compare", "--bots", "oracle,random", "--n", "15"]);
    expect(code).toBe(0);
    expect(output).toMatch(/oracle +100\.0%/);
    expect(output).toMatch(/random/);
  });

  it("compares bots as JSON, in the order given", () => {
    const { output } = main(["compare", "--bots", "random,oracle", "--n", "5", "--json"]);
    expect((JSON.parse(output) as Array<{ bot: string }>).map((report) => report.bot)).toEqual(["random", "oracle"]);
  });

  it("explains that whole runs are not available until the run loop exists", () => {
    const { code, output } = main(["runs", "--bot", "greedy", "--n", "10"]);
    expect(code).toBe(1);
    expect(output).toMatch(/run loop/);
    expect(output).toMatch(/sim fights/);
  });

  it("rejects bad input with an explanation", () => {
    const bad: Array<[string[], RegExp]> = [
      [["fights"], /--bot/],
      [["fights", "--bot", "clever"], /Unknown bot "clever"/],
      [["fights", "--bot", "oracle", "--n", "0"], /--n must be a whole number/],
      [["fights", "--bot", "oracle", "--n", "2.5"], /--n must be a whole number/],
      [["fights", "--bot", "oracle", "--seed-base", "-4"], /--seed-base must be a whole number/],
      [["fights", "--bot", "oracle", "--tier", "king"], /--tier must be one of minion, elite, boss/],
      [["fights", "--bot", "oracle", "--loadout", "big"], /--loadout must be one of starting, full/],
      [["fights", "--bot", "oracle", "--bott", "x"], /Unknown option --bott/],
      [["compare"], /--bots/],
      [["compare", "--bots", "oracle,clever"], /Unknown bot "clever"/],
      [["dance"], /Unknown command "dance"/],
    ];
    eachCase(bad.map((pair) => [JSON.stringify(pair[0]), pair] as const), ([argv, message]) => {
      const { code, output } = main(argv);
      expect(code).toBe(1);
      expect(output).toMatch(message);
    });
  });
});
