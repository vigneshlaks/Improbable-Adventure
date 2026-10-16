import { describe, expect, it } from "vitest";
import { formatRunComparison, formatRunReport } from "./runFormat";
import { checkTargets, summarizeRuns } from "./runReport";
import { RUN_META, RUNS } from "./runReportFixtures";

const report = summarizeRuns(RUNS, RUN_META);

describe("formatRunReport", () => {
  const text = formatRunReport(report, checkTargets([report]));

  it("names what was run", () => {
    expect(text).toMatch(/greedy/);
    expect(text).toMatch(/4 runs/);
    expect(text).toMatch(/seeds 1 to 4/);
  });

  it("shows the outcome, the win rate with its interval, and the fights won", () => {
    expect(text).toMatch(/Won +50\.0%/);
    expect(text).toMatch(/95% interval/);
    expect(text).toMatch(/Fights won per run +5\.25/);
  });

  it("says where the runs that were lost ended", () => {
    expect(text).toMatch(/Ended on fight 3 \(minion\) +25\.0%/); // encounters count from 0 inside, from 1 on screen
    expect(text).toMatch(/Ended on fight 6 \(elite\) +25\.0%/);
  });

  it("gives the win rate of the fights of each tier, in act order", () => {
    expect(text).toMatch(/minion +17 of 18 +94\.4%/);
    expect(text).toMatch(/elite +2 of 3 +66\.7%/);
    expect(text).toMatch(/boss +2 of 2 +100\.0%/);
    expect(text.indexOf("minion")).toBeLessThan(text.indexOf("boss"));
  });

  it("describes the won runs: turns, Certainty left, structures, openers and fusions", () => {
    expect(text).toMatch(/Turns per won run +21\.0/);
    expect(text).toMatch(/Certainty left +30\.0/);
    expect(text).toMatch(/Bloom Filter +100\.0%/);
    expect(text).toMatch(/Count-Min Sketch +50\.0%/);
    expect(text).toMatch(/Fused a HyperLogLog\W+50\.0%|Fused +50\.0%/);
  });

  it("shows the strike numbers and each target as met or missed", () => {
    expect(text).toMatch(/Strikes per run +20\.00/);
    expect(text).toMatch(/Wrong strikes +31\.3%/);
    expect(text).toMatch(/missed .*Greedy wins 55 to 70 percent of runs.*50\.0%/);
  });

  it("says so when no run was won", () => {
    expect(formatRunReport(summarizeRuns([RUNS[1]!], RUN_META), [])).toMatch(/no run was won/i);
  });
});

describe("formatRunComparison", () => {
  it("puts each bot on its own row with the headline numbers", () => {
    const text = formatRunComparison([report, { ...report, bot: "oracle", winRate: 1, winRateInterval: [0.5, 1] }]);
    expect(text).toMatch(/Bot +Win rate/);
    expect(text).toMatch(/greedy +50\.0%/);
    expect(text).toMatch(/oracle +100\.0%/);
    expect(text.split("\n").filter((line) => /greedy|oracle/.test(line))).toHaveLength(2);
  });
});
