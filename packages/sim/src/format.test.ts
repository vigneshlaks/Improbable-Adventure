import { describe, expect, it } from "vitest";
import { formatComparison, formatReport, percent } from "./format";
import { summarize } from "./report";
import { META, RECORDS } from "./reportFixtures";

const report = summarize(RECORDS, META);

describe("percent", () => {
  it("shows one decimal place", () => {
    expect(percent(0.5)).toBe("50.0%");
    expect(percent(0.12345)).toBe("12.3%");
    expect(percent(1)).toBe("100.0%");
  });
});

describe("formatReport", () => {
  const text = formatReport(report);

  it("names what was run", () => {
    expect(text).toMatch(/greedy/);
    expect(text).toMatch(/minion/);
    expect(text).toMatch(/starting loadout/);
    expect(text).toMatch(/4 fights/);
  });

  it("shows outcomes, the win rate and its interval", () => {
    expect(text).toMatch(/Won +50\.0%/);
    expect(text).toMatch(/Lost to the turn limit +25\.0%/);
    expect(text).toMatch(/Lost to Certainty +25\.0%/);
    expect(text).toMatch(/95% interval/);
  });

  it("shows turns, Certainty left, and Certainty lost by cause", () => {
    expect(text).toMatch(/Turns per fight +5\.5/);
    expect(text).toMatch(/Certainty left +50\.0/);
    expect(text).toMatch(/Enemy attacks +15\.00/);
    expect(text).toMatch(/Blocked Frequency strikes +6\.75/);
  });

  it("shows the strike count and the share of wrong strikes", () => {
    expect(text).toMatch(/Strikes per fight +4\.25/);
    expect(text).toMatch(/Wrong strikes +70\.6%/);
  });

  it("lists each structure with its deploy rate and win rate", () => {
    expect(text).toMatch(/Count-Min Sketch +75\.0% +66\.7%/);
    expect(text).toMatch(/Bloom Filter +75\.0% +33\.3%/);
  });

  it("lists how often each structure's range held the truth, against its stated confidence", () => {
    expect(text).toMatch(/Count-Min Sketch +3 +66\.7% +98\.0% +20\.0%/);
    expect(text).toMatch(/Bloom Filter +3 +66\.7% +95\.0% +n\/a/);
  });
});

describe("formatComparison", () => {
  it("puts each bot on its own row with the headline numbers", () => {
    const text = formatComparison([report, { ...report, bot: "oracle", winRate: 1, winRateInterval: [0.9, 1] }]);
    expect(text).toMatch(/Bot +Win rate/);
    expect(text).toMatch(/greedy +50\.0%/);
    expect(text).toMatch(/oracle +100\.0%/);
    expect(text.split("\n").filter((line) => /greedy|oracle/.test(line))).toHaveLength(2);
  });
});
