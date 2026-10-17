import { buildRunConfig } from "@pda/content";
import { STRUCTURE_KINDS, type StructureKind } from "@pda/engine";
import { getBot } from "./bots";
import { playRun, type RunRecord } from "./runRunner";
import { wilsonInterval } from "./stats";

export interface TierFights {
  played: number;
  won: number;
  winRate: number;
  /** Fights lost by reaching the turn limit, the rest of the lost ones being lost by running out of Certainty. */
  lostToTurnLimit: number;
}

/** The metrics the spec asks for, summed over a batch of whole runs. */
export interface RunReport {
  bot: string;
  seedBase: number;
  runs: number;
  outcomes: { won: number; lost: number; stalled: number };
  winRate: number;
  /** The 95% confidence interval for the win rate. */
  winRateInterval: [number, number];
  meanFightsWon: number;
  /** Where the runs that were not won ended, as a share of all runs, in act order. */
  endedAt: Array<{ encounter: number; tier: string; share: number }>;
  /** The fights that were won or lost, by tier. */
  fights: Record<string, TierFights>;
  meanTurnsWhenWon: number | null;
  meanCertaintyLeftWhenWon: number | null;
  strikes: { meanPerRun: number; wrongShare: number };
  /** What the runs that were won looked like: the share of them that deployed each structure, opened with each, and fused. */
  inWinningRuns: {
    runs: number;
    structures: Partial<Record<StructureKind, number>>;
    openers: Partial<Record<StructureKind, number>>;
    fusedShare: number;
    /** The share that attached at least one enchantment. */
    enchantedShare: number;
  };
}

export interface RunReportMeta {
  bot: string;
  seedBase: number;
}

const sum = (records: RunRecord[], pick: (record: RunRecord) => number) => records.reduce((total, record) => total + pick(record), 0);

/** Combines many run records into one report. */
export function summarizeRuns(records: RunRecord[], meta: RunReportMeta): RunReport {
  const n = records.length;
  if (n === 0) throw new RangeError("Cannot summarize zero runs");
  const won = records.filter((record) => record.outcome === "won");

  const endings = new Map<number, { tier: string; count: number }>();
  for (const record of records) {
    if (record.outcome === "won") continue;
    const entry = endings.get(record.encounterReached) ?? { tier: record.fights.at(-1)?.tier ?? "unknown", count: 0 };
    entry.count++;
    endings.set(record.encounterReached, entry);
  }

  const tallies = new Map<string, { played: number; won: number; lostToTurnLimit: number }>();
  for (const record of records) {
    for (const fight of record.fights) {
      if (fight.outcome === "stalled") continue;
      const tally = tallies.get(fight.tier) ?? { played: 0, won: 0, lostToTurnLimit: 0 };
      tally.played++;
      if (fight.outcome === "won") tally.won++;
      if (fight.reason === "turnLimit") tally.lostToTurnLimit++;
      tallies.set(fight.tier, tally);
    }
  }

  const shareOf = <T extends string>(pick: (record: RunRecord) => T[]): Partial<Record<T, number>> => {
    const counts = new Map<T, number>();
    for (const record of won) for (const item of pick(record)) counts.set(item, (counts.get(item) ?? 0) + 1);
    return Object.fromEntries([...counts].map(([item, count]) => [item, count / won.length])) as Partial<Record<T, number>>;
  };

  const strikes = sum(records, (record) => record.strikes.total);
  return {
    ...meta,
    runs: n,
    outcomes: { won: won.length, lost: records.filter((r) => r.outcome === "lost").length, stalled: records.filter((r) => r.outcome === "stalled").length },
    winRate: won.length / n,
    winRateInterval: wilsonInterval(won.length, n),
    meanFightsWon: sum(records, (record) => record.fightsWon) / n,
    endedAt: [...endings].sort(([a], [b]) => a - b).map(([encounter, entry]) => ({ encounter, tier: entry.tier, share: entry.count / n })),
    fights: Object.fromEntries([...tallies].map(([tier, t]) => [tier, { ...t, winRate: t.won / t.played }])),
    meanTurnsWhenWon: won.length === 0 ? null : sum(won, (record) => record.turns) / won.length,
    meanCertaintyLeftWhenWon: won.length === 0 ? null : sum(won, (record) => record.certaintyLeft) / won.length,
    strikes: { meanPerRun: strikes / n, wrongShare: strikes === 0 ? 0 : sum(records, (record) => record.strikes.wrong) / strikes },
    inWinningRuns: {
      runs: won.length,
      structures: shareOf((record) => record.deployed),
      openers: shareOf((record) => (record.opener ? [record.opener] : [])),
      fusedShare: won.length === 0 ? 0 : won.filter((record) => record.fused.length > 0).length / won.length,
      enchantedShare: won.length === 0 ? 0 : won.filter((record) => record.enchanted.length > 0).length / won.length,
    },
  };
}

export interface TargetCheck {
  id: string;
  /** What the target says, in words. */
  target: string;
  ok: boolean;
  /** What was measured, or why it could not be. */
  detail: string;
}

/** The bots whose winning runs are pooled for the opener and structure targets. */
const FAMILY = ["greedy", "prober", "cautious"];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The structures the MVP ships, which the spec wants to see in at least 15 percent of winning runs. */
const MVP_STRUCTURES = STRUCTURE_KINDS.filter((kind) => kind !== "hyperLogLog");

/**
 * Checks the reports against the spec's initial balance targets. A target is only checked for the bots whose reports
 * are given: Greedy wins 55 to 70 percent, Random under 5, Oracle over 95; Greedy's wrong strikes 10 to 30 percent;
 * no opener in more than 40 percent, and every MVP structure in at least 15 percent, of the winning runs of the
 * Greedy family (Greedy, Prober and Cautious), pooled so that each bot counts in proportion to its wins. Pooling is
 * what the spec means: the Prober opens with Reservoir Sampling by definition, and Greedy never prefers it.
 */
export function checkTargets(reports: RunReport[]): TargetCheck[] {
  const checks: TargetCheck[] = [];
  const get = (bot: string) => reports.find((report) => report.bot === bot);

  const greedy = get("greedy");
  if (greedy) {
    checks.push({ id: "greedy-win-rate", target: "Greedy wins 55 to 70 percent of runs", ok: greedy.winRate >= 0.55 && greedy.winRate <= 0.7, detail: pct(greedy.winRate) });
  }
  const random = get("random");
  if (random) checks.push({ id: "random-win-rate", target: "Random wins under 5 percent of runs", ok: random.winRate < 0.05, detail: pct(random.winRate) });
  const oracle = get("oracle");
  if (oracle) checks.push({ id: "oracle-win-rate", target: "Oracle wins over 95 percent of runs", ok: oracle.winRate > 0.95, detail: pct(oracle.winRate) });

  if (greedy) {
    checks.push({
      id: "greedy-wrong-strikes",
      target: "Greedy's wrong strikes are 10 to 30 percent",
      ok: greedy.strikes.wrongShare >= 0.1 && greedy.strikes.wrongShare <= 0.3,
      detail: pct(greedy.strikes.wrongShare),
    });
  }

  const family = reports.filter((report) => FAMILY.includes(report.bot) && report.inWinningRuns.runs > 0);
  if (reports.some((report) => FAMILY.includes(report.bot))) {
    const wins = family.reduce((total, report) => total + report.inWinningRuns.runs, 0);
    /** For each item, the share of all the family's winning runs that had it. */
    const pooled = (pick: (report: RunReport) => Partial<Record<StructureKind, number>>): Map<StructureKind, number> => {
      const shares = new Map<StructureKind, number>();
      for (const report of family) {
        for (const [kind, share] of Object.entries(pick(report)) as Array<[StructureKind, number]>) {
          shares.set(kind, (shares.get(kind) ?? 0) + (share * report.inWinningRuns.runs) / wins);
        }
      }
      return shares;
    };
    const openerTarget = "No opener is used in more than 40 percent of the Greedy family's winning runs";
    const structureTarget = "Every MVP structure appears in at least 15 percent of the Greedy family's winning runs";
    if (wins === 0) {
      checks.push({ id: "family-opener", target: openerTarget, ok: false, detail: "no winning runs to measure" });
      checks.push({ id: "family-structures", target: structureTarget, ok: false, detail: "no winning runs to measure" });
    } else {
      const worst = [...pooled((report) => report.inWinningRuns.openers)].sort(([, a], [, b]) => b - a)[0];
      checks.push({ id: "family-opener", target: openerTarget, ok: (worst?.[1] ?? 0) <= 0.4, detail: worst ? `${worst[0]} ${pct(worst[1])}` : "no opener" });
      const used = pooled((report) => report.inWinningRuns.structures);
      const short = MVP_STRUCTURES.filter((kind) => (used.get(kind) ?? 0) < 0.15);
      checks.push({
        id: "family-structures",
        target: structureTarget,
        ok: short.length === 0,
        detail: short.length === 0 ? "all six" : `below 15 percent: ${short.map((kind) => `${kind} ${pct(used.get(kind) ?? 0)}`).join(", ")}`,
      });
    }
  }
  return checks;
}

export interface RunBatchOptions {
  botName: string;
  /** Number of runs. */
  n: number;
  /** Run i uses the seed `seedBase + i`, so the same inputs always give the same report. */
  seedBase: number;
  maxSteps?: number;
}

/** Plays `n` seeded whole runs with one bot and summarizes them. */
export function runBatch({ botName, n, seedBase, maxSteps }: RunBatchOptions): RunReport {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a whole number >= 1, got ${n}`);
  const bot = getBot(botName);
  const records = Array.from({ length: n }, (_, i) => {
    const seed = String(seedBase + i);
    return playRun({ config: buildRunConfig({ seed }), seed, bot, ...(maxSteps !== undefined ? { maxSteps } : {}) });
  });
  return summarizeRuns(records, { bot: bot.name, seedBase });
}
