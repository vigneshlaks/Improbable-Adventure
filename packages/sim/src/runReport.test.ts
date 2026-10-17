import { describe, expect, it } from "vitest";
import { checkTargets, runBatch, summarizeRuns, type RunReport } from "./runReport";
import { RUN_META, RUNS } from "./runReportFixtures";
import { wilsonInterval } from "./stats";

describe("summarizeRuns", () => {
  const report = summarizeRuns(RUNS, RUN_META);

  it("counts outcomes and gives the win rate with an interval", () => {
    expect(report).toMatchObject({ bot: "greedy", seedBase: 1, runs: 4 });
    expect(report.outcomes).toEqual({ won: 2, lost: 2, stalled: 0 });
    expect(report.winRate).toBe(0.5);
    expect(report.winRateInterval).toEqual(wilsonInterval(2, 4));
  });

  it("averages how many fights a run won, and says where the lost runs ended", () => {
    expect(report.meanFightsWon).toBe(5.25); // (7 + 2 + 5 + 7) / 4
    expect(report.endedAt).toEqual([
      { encounter: 2, tier: "minion", share: 0.25 },
      { encounter: 5, tier: "elite", share: 0.25 },
    ]);
  });

  it("gives the win rate of the fights of each tier", () => {
    expect(report.fights.minion).toEqual({ played: 18, won: 17, winRate: 17 / 18, lostToTurnLimit: 0 });
    expect(report.fights.elite).toEqual({ played: 3, won: 2, winRate: 2 / 3, lostToTurnLimit: 1 });
    expect(report.fights.boss).toEqual({ played: 2, won: 2, winRate: 1, lostToTurnLimit: 0 });
  });

  it("counts the fights lost to the turn limit, which are the ones lost without running out of Certainty", () => {
    expect(report.fights.minion?.lostToTurnLimit).toBe(0); // the one Minion fight lost ran out of Certainty
    expect(report.fights.elite?.lostToTurnLimit).toBe(1);
  });

  it("averages the turns and the Certainty left over the won runs only", () => {
    expect(report.meanTurnsWhenWon).toBe(21);
    expect(report.meanCertaintyLeftWhenWon).toBe(30);
  });

  it("reports strikes per run and the share that were wrong", () => {
    expect(report.strikes.meanPerRun).toBe(20); // 80 strikes in 4 runs
    expect(report.strikes.wrongShare).toBeCloseTo(25 / 80, 12);
  });

  it("says which structures were used, which opener, and how often it fused, among the won runs", () => {
    expect(report.inWinningRuns.runs).toBe(2);
    expect(report.inWinningRuns.structures).toEqual({
      bloomFilter: 1,
      countMinSketch: 0.5,
      hyperLogLog: 0.5,
      logLog: 0.5,
      reservoirSampling: 0.5,
    });
    expect(report.inWinningRuns.openers).toEqual({ bloomFilter: 1 });
    expect(report.inWinningRuns.fusedShare).toBe(0.5);
  });

  it("lists where runs ended in act order whatever order the runs come in", () => {
    expect(summarizeRuns([RUNS[2]!, RUNS[1]!], RUN_META).endedAt.map((end) => end.encounter)).toEqual([2, 5]);
  });

  it("leaves a fight that never finished out of the tier win rates, and counts a run that stalled", () => {
    const stalled = { ...RUNS[1]!, outcome: "stalled" as const, fights: [...RUNS[1]!.fights.slice(0, 2), { tier: "minion", outcome: "stalled" as const, turns: 0, reason: null }] };
    const report = summarizeRuns([stalled], RUN_META);
    expect(report.outcomes).toEqual({ won: 0, lost: 0, stalled: 1 });
    expect(report.fights.minion).toEqual({ played: 2, won: 2, winRate: 1, lostToTurnLimit: 0 });
  });

  it("handles a batch with no won runs", () => {
    const lost = summarizeRuns([RUNS[1]!, RUNS[2]!], RUN_META);
    expect(lost.meanTurnsWhenWon).toBeNull();
    expect(lost.meanCertaintyLeftWhenWon).toBeNull();
    expect(lost.inWinningRuns).toEqual({ runs: 0, structures: {}, openers: {}, fusedShare: 0 });
  });

  it("refuses to summarize nothing", () => {
    expect(() => summarizeRuns([], RUN_META)).toThrow(RangeError);
  });
});

describe("checkTargets", () => {
  /** A report with the given win rate and wrong-strike share, and winning runs that use these structures and openers. */
  const reportFor = (
    bot: string,
    winRate: number,
    wrongShare = 0.2,
    structures: RunReport["inWinningRuns"]["structures"] = {},
    openers: RunReport["inWinningRuns"]["openers"] = { bloomFilter: 0.3, exactMemory: 0.3, linearCounting: 0.4 },
    wonRuns = 10,
  ): RunReport => ({
    ...summarizeRuns(RUNS, { bot, seedBase: 1 }),
    winRate,
    strikes: { meanPerRun: 20, wrongShare },
    inWinningRuns: { runs: wonRuns, structures, openers, fusedShare: 0 },
  });
  const all = { exactMemory: 0.5, reservoirSampling: 0.5, bloomFilter: 0.5, countMinSketch: 0.5, logLog: 0.5, linearCounting: 0.5 };
  const by = (checks: ReturnType<typeof checkTargets>, id: string) => checks.find((check) => check.id === id);

  it("checks the win rate of each bot against its target: Greedy 55 to 70 percent, Random under 5, Oracle over 95", () => {
    const good = checkTargets([reportFor("greedy", 0.6), reportFor("random", 0.02), reportFor("oracle", 0.99)]);
    expect([by(good, "greedy-win-rate")?.ok, by(good, "random-win-rate")?.ok, by(good, "oracle-win-rate")?.ok]).toEqual([true, true, true]);
    const bad = checkTargets([reportFor("greedy", 0.54), reportFor("random", 0.05), reportFor("oracle", 0.95)]);
    expect([by(bad, "greedy-win-rate")?.ok, by(bad, "random-win-rate")?.ok, by(bad, "oracle-win-rate")?.ok]).toEqual([false, false, false]);
    expect(by(checkTargets([reportFor("greedy", 0.7)]), "greedy-win-rate")?.ok).toBe(true); // the range includes both ends
    expect(by(checkTargets([reportFor("greedy", 0.71)]), "greedy-win-rate")?.ok).toBe(false);
  });

  it("only checks the bots it was given", () => {
    expect(checkTargets([reportFor("greedy", 0.6)]).map((check) => check.id)).not.toContain("random-win-rate");
    // With no Greedy-family bot at all there is nothing to say about openers or structure use.
    expect(checkTargets([reportFor("oracle", 1)]).map((check) => check.id)).toEqual(["oracle-win-rate"]);
  });

  it("checks that no opener is used in more than 40 percent of the winning runs of the Greedy family, pooled over the bots given", () => {
    // Prober always opens with Reservoir Sampling, so that is only a problem if it is most of what the family does.
    const greedy = reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 0.5, exactMemory: 0.5 }, 10);
    const prober = reportFor("prober", 0.4, 0.2, all, { reservoirSampling: 1 }, 10);
    const cautious = reportFor("cautious", 0.2, 0.2, all, { linearCounting: 1 }, 10);
    const pooled = by(checkTargets([greedy, prober, cautious]), "family-opener");
    expect(pooled?.ok).toBe(true); // 5 + 5 of 30 for Bloom and Exact Memory, 10 of 30 for Reservoir and for Linear Counting: 33 percent at most

    const lopsided = by(checkTargets([reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 1 }, 10), prober]), "family-opener");
    expect(lopsided?.ok).toBe(false); // Bloom is 10 of 20
    expect(lopsided?.detail).toMatch(/bloomFilter 50\.0%/);
    expect(checkTargets([reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 0.4, exactMemory: 0.6 }, 10)]).find((c) => c.id === "family-opener")?.ok).toBe(false);
    expect(checkTargets([reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 0.4, exactMemory: 0.3, linearCounting: 0.3 }, 10)]).find((c) => c.id === "family-opener")?.ok).toBe(true); // 40 percent is allowed
  });

  it("weights each bot by how many winning runs it had", () => {
    const many = reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 1 }, 90);
    const few = reportFor("prober", 0.4, 0.2, all, { reservoirSampling: 1 }, 10);
    expect(by(checkTargets([many, few]), "family-opener")?.detail).toMatch(/bloomFilter 90\.0%/);
  });

  it("ignores the Oracle and Random when pooling, since they do not choose openers like a player", () => {
    const oracle = reportFor("oracle", 1, 0, { bloomFilter: 1 }, { bloomFilter: 1 }, 100); // were it pooled, Bloom would open 103 of 110 runs
    const greedy = reportFor("greedy", 0.6, 0.2, all, { bloomFilter: 0.3, exactMemory: 0.3, linearCounting: 0.4 }, 10);
    expect(by(checkTargets([greedy, oracle]), "family-opener")?.ok).toBe(true);
  });

  it("includes both ends of the wrong-strike range", () => {
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.1)]), "greedy-wrong-strikes")?.ok).toBe(true);
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.3)]), "greedy-wrong-strikes")?.ok).toBe(true);
  });

  it("checks that the wrong strikes of Greedy are 10 to 30 percent", () => {
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.2)]), "greedy-wrong-strikes")?.ok).toBe(true);
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.09)]), "greedy-wrong-strikes")?.ok).toBe(false);
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.31)]), "greedy-wrong-strikes")?.ok).toBe(false);
  });

  it("checks that every MVP structure appears in at least 15 percent of the winning runs of the Greedy family, naming the ones that do not", () => {
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.2, all)]), "family-structures")?.ok).toBe(true);
    const missing = by(checkTargets([reportFor("greedy", 0.6, 0.2, { ...all, logLog: 0.14, countMinSketch: 0 })]), "family-structures");
    expect(missing?.ok).toBe(false);
    expect(missing?.detail).toMatch(/logLog/);
    expect(missing?.detail).toMatch(/countMinSketch/);
  });

  it("allows a structure to be in exactly 15 percent of the winning runs", () => {
    const edge = { exactMemory: 0.15, reservoirSampling: 0.15, bloomFilter: 0.15, countMinSketch: 0.15, logLog: 0.15, linearCounting: 0.15 };
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.2, edge)]), "family-structures")?.ok).toBe(true);
    expect(by(checkTargets([reportFor("greedy", 0.6, 0.2, { ...edge, logLog: 0.149 })]), "family-structures")?.ok).toBe(false);
  });

  it("counts a structure used by any bot of the family: Greedy never deploys Reservoir Sampling, but the Prober always does", () => {
    const { reservoirSampling: _unused, ...withoutReservoir } = all;
    void _unused;
    const greedy = reportFor("greedy", 0.6, 0.2, withoutReservoir, { bloomFilter: 1 }, 10);
    expect(by(checkTargets([greedy]), "family-structures")?.ok).toBe(false);
    const prober = reportFor("prober", 0.4, 0.2, { reservoirSampling: 1 }, { reservoirSampling: 1 }, 10);
    expect(by(checkTargets([greedy, prober]), "family-structures")?.ok).toBe(true); // Reservoir: 10 of 20
  });

  it("fails the checks that need winning runs when there are none, and says why", () => {
    const none: RunReport = { ...reportFor("greedy", 0), inWinningRuns: { runs: 0, structures: {}, openers: {}, fusedShare: 0 } };
    const checks = checkTargets([none]);
    expect(by(checks, "family-opener")).toMatchObject({ ok: false, detail: expect.stringMatching(/no winning runs/i) });
    expect(by(checks, "family-structures")).toMatchObject({ ok: false, detail: expect.stringMatching(/no winning runs/i) });
  });
});

describe("runBatch", () => {
  it("plays the requested number of whole runs and reports them, the same way for the same seeds", () => {
    const options = { botName: "oracle", n: 3, seedBase: 1 };
    const report = runBatch(options);
    expect(report).toMatchObject({ bot: "oracle", runs: 3, seedBase: 1, winRate: 1 });
    expect(report.fights.boss?.played).toBe(3);
    expect(runBatch(options)).toEqual(report);
    expect(runBatch({ ...options, seedBase: 50 })).not.toEqual(report);
  });

  it("keeps the act winnable and not trivial (measured over 300 runs: Greedy 48 percent, Random 0.3, Oracle 100)", () => {
    // These are floors and ceilings well away from the measured numbers, to catch a regression such as the 1.3 percent
    // Greedy won before the Elite and Boss were retuned. The spec's target for Greedy is 55 to 70 percent; see the notes.
    const rate = (botName: string) => runBatch({ botName, n: 60, seedBase: 1 }).winRate;
    expect(rate("oracle")).toBeGreaterThan(0.95);
    expect(rate("greedy")).toBeGreaterThan(0.3);
    expect(rate("random")).toBeLessThan(0.05);
  });

  it("rejects a bad count", () => {
    expect(() => runBatch({ botName: "oracle", n: 0, seedBase: 1 })).toThrow(RangeError);
    expect(() => runBatch({ botName: "oracle", n: 2.5, seedBase: 1 })).toThrow(RangeError);
  });
});
