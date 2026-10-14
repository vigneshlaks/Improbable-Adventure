import { structures } from "@pda/content";
import type { StructureKind } from "@pda/engine";
import type { FightReport } from "./report";

/** A share as a percentage with one decimal. */
export const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

const NAME_WIDTH = 28;
const row = (label: string, ...values: string[]) => `  ${label.padEnd(NAME_WIDTH)}${values.map((value) => value.padStart(10)).join("")}`;
const heading = (label: string, ...columns: string[]) => `${label.padEnd(NAME_WIDTH + 2)}${columns.map((column) => column.padStart(10)).join("")}`;
const kindsIn = (record: Partial<Record<StructureKind, unknown>>) => (Object.keys(record) as StructureKind[]);
const nameOf = (kind: StructureKind) => structures[kind].name;

function countDuelLines(duel: FightReport["countDuel"]): string[] {
  if (duel.logLogCloserShare === null) return ["  no Count challenge came up"];
  return [
    row("Fights with a Count challenge", String(duel.fights)),
    row("LogLog closer than Linear Counting", percent(duel.logLogCloserShare)) + `   (of ${duel.challenges} challenges)`,
    row("Most distinct values seen", String(duel.largestDistinct)),
  ];
}

/** The full report for one bot, as text. */
export function formatReport(report: FightReport): string {
  const { outcomes, meanCertaintyLost: lost } = report;
  const [low, high] = report.winRateInterval;
  const share = (count: number) => percent(count / report.fights);

  const lines = [
    `${report.bot} against ${report.tier} enemies, ${report.loadout} loadout: ${report.fights} fights (seeds ${report.seedBase} to ${report.seedBase + report.fights - 1})`,
    "",
    "Outcome",
    row("Won", percent(report.winRate)) + `   (95% interval ${percent(low)} to ${percent(high)})`,
    row("Lost to the turn limit", share(outcomes.lostToTurnLimit)),
    row("Lost to Certainty", share(outcomes.lostToCertainty)),
    row("Stalled", share(outcomes.stalled)),
    "",
    row("Turns per fight", report.meanTurns.toFixed(1)),
    row("Certainty left", report.meanCertaintyLeft.toFixed(1)),
    "",
    "Certainty lost per fight, by cause",
    row("Enemy attacks", lost.attacks.toFixed(2)),
    row("Blocked Frequency strikes", lost.blocked.toFixed(2)),
    row("Decoys struck in Presence", lost.decoys.toFixed(2)),
    row("Count misses", lost.misses.toFixed(2)),
    row("Turn-limit penalty", lost.turnLimit.toFixed(2)),
    "",
    row("Strikes per fight", report.strikes.meanPerFight.toFixed(2)),
    row("Wrong strikes", percent(report.strikes.wrongShare)),
    "",
    heading("Structures", "deployed", "won then"),
    ...kindsIn(report.structures).map((kind) => {
      const entry = report.structures[kind]!;
      return row(nameOf(kind), percent(entry.deployedShare), percent(entry.winRateWhenDeployed));
    }),
    ...(kindsIn(report.structures).length === 0 ? ["  none deployed"] : []),
    "",
    heading("Answers against the truth", "answers", "in range", "claimed", "error"),
    ...kindsIn(report.accuracy).map((kind) => {
      const entry = report.accuracy[kind]!;
      return row(
        nameOf(kind),
        String(entry.answers),
        percent(entry.withinRange),
        percent(entry.statedConfidence),
        entry.meanRelativeError === null ? "n/a" : percent(entry.meanRelativeError),
      );
    }),
    ...(kindsIn(report.accuracy).length === 0 ? ["  no structure answered"] : []),
    "",
    "Count structures at equal Space (each holding all the starting Space)",
    ...countDuelLines(report.countDuel),
  ];
  return lines.join("\n");
}

/** Several bots' headline numbers side by side. They should have been run on the same fights. */
export function formatComparison(reports: FightReport[]): string {
  const first = reports[0];
  if (!first) return "No bots to compare.";
  const header = `${first.tier} enemies, ${first.loadout} loadout, ${first.fights} fights each (seeds ${first.seedBase} to ${first.seedBase + first.fights - 1})`;
  const columns = (bot: string, win: string, interval: string, turns: string, left: string, wrong: string) =>
    `${bot.padEnd(12)}${win.padStart(10)}${interval.padStart(20)}${turns.padStart(8)}${left.padStart(18)}${wrong.padStart(16)}`;

  return [
    header,
    "",
    columns("Bot", "Win rate", "95% interval", "Turns", "Certainty left", "Wrong strikes"),
    ...reports.map((report) =>
      columns(
        report.bot,
        percent(report.winRate),
        `${percent(report.winRateInterval[0])} to ${percent(report.winRateInterval[1])}`,
        report.meanTurns.toFixed(1),
        report.meanCertaintyLeft.toFixed(1),
        percent(report.strikes.wrongShare),
      ),
    ),
  ].join("\n");
}
