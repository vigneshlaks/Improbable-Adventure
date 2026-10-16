import { structures } from "@pda/content";
import type { StructureKind } from "@pda/engine";
import { percent } from "./format";
import type { RunReport, TargetCheck } from "./runReport";

const NAME_WIDTH = 34;
const row = (label: string, ...values: string[]) => `  ${label.padEnd(NAME_WIDTH)}${values.map((value) => value.padStart(10)).join("")}`;
const TIER_ORDER = ["minion", "elite", "boss"];
const nameOf = (kind: string) => structures[kind as StructureKind]?.name ?? kind;
const byShare = (shares: Record<string, number | undefined>) =>
  Object.entries(shares).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0)) as Array<[string, number]>;

/** The full report for one bot over whole runs, as text, with each of the spec's targets as met or missed. */
export function formatRunReport(report: RunReport, checks: TargetCheck[]): string {
  const [low, high] = report.winRateInterval;
  const won = report.inWinningRuns;
  const lines = [
    `${report.bot}: ${report.runs} runs (seeds ${report.seedBase} to ${report.seedBase + report.runs - 1})`,
    "",
    "Outcome",
    row("Won", percent(report.winRate)) + `   (95% interval ${percent(low)} to ${percent(high)})`,
    ...(report.outcomes.stalled > 0 ? [row("Stalled", percent(report.outcomes.stalled / report.runs))] : []),
    row("Fights won per run", report.meanFightsWon.toFixed(2)),
    ...report.endedAt.map((end) => row(`Ended on fight ${end.encounter + 1} (${end.tier})`, percent(end.share))),
    "",
    "Fights, by tier",
    ...Object.keys(report.fights)
      .sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b))
      .map((tier) => {
        const entry = report.fights[tier]!;
        return row(tier, `${entry.won} of ${entry.played}`, percent(entry.winRate));
      }),
    "",
  ];

  if (report.outcomes.won === 0) {
    lines.push("No run was won, so there is nothing to say about winning runs.");
  } else {
    lines.push(
      `Won runs (${won.runs})`,
      row("Turns per won run", (report.meanTurnsWhenWon as number).toFixed(1)),
      row("Certainty left", (report.meanCertaintyLeftWhenWon as number).toFixed(1)),
      row("Fused", percent(won.fusedShare)),
      "  Structures deployed in these runs",
      ...byShare(won.structures).map(([kind, share]) => row(`  ${nameOf(kind)}`, percent(share))),
      "  First structure deployed",
      ...byShare(won.openers).map(([kind, share]) => row(`  ${nameOf(kind)}`, percent(share))),
    );
  }

  lines.push(
    "",
    "Strikes",
    row("Strikes per run", report.strikes.meanPerRun.toFixed(2)),
    row("Wrong strikes", percent(report.strikes.wrongShare)),
  );

  if (checks.length > 0) {
    lines.push("", "Spec targets", ...checks.map((check) => `  ${check.ok ? "met   " : "missed"}  ${check.target}: ${check.detail}`));
  }
  return lines.join("\n");
}

/** Several bots' headline numbers side by side. They should have been run on the same seeds. */
export function formatRunComparison(reports: RunReport[]): string {
  const first = reports[0];
  if (!first) return "No bots to compare.";
  const header = `${first.runs} runs each (seeds ${first.seedBase} to ${first.seedBase + first.runs - 1})`;
  const columns = (bot: string, win: string, interval: string, fights: string, turns: string, left: string, wrong: string) =>
    `${bot.padEnd(12)}${win.padStart(10)}${interval.padStart(20)}${fights.padStart(8)}${turns.padStart(8)}${left.padStart(18)}${wrong.padStart(16)}`;
  return [
    header,
    "",
    columns("Bot", "Win rate", "95% interval", "Fights", "Turns", "Certainty left", "Wrong strikes"),
    ...reports.map((report) =>
      columns(
        report.bot,
        percent(report.winRate),
        `${percent(report.winRateInterval[0])} to ${percent(report.winRateInterval[1])}`,
        report.meanFightsWon.toFixed(1),
        report.meanTurnsWhenWon === null ? "n/a" : report.meanTurnsWhenWon.toFixed(1),
        report.meanCertaintyLeftWhenWon === null ? "n/a" : report.meanCertaintyLeftWhenWon.toFixed(1),
        percent(report.strikes.wrongShare),
      ),
    ),
  ].join("\n");
}
