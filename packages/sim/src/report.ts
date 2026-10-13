import { buildFightConfig, type TierName } from "@pda/content";
import { STRUCTURE_KINDS, type StructureKind } from "@pda/engine";
import type { Bot } from "./bots/types";
import { playFight, type AccuracyTally, type FightRecord } from "./runner";
import { wilsonInterval } from "./stats";

export type LoadoutName = "starting" | "full";

/** The metrics the spec asks for, summed over a batch of fights. */
export interface FightReport {
  bot: string;
  tier: string;
  loadout: string;
  seedBase: number;
  fights: number;
  outcomes: { won: number; lost: number; stalled: number; lostToTurnLimit: number; lostToCertainty: number };
  winRate: number;
  /** The 95% confidence interval for the win rate. */
  winRateInterval: [number, number];
  meanTurns: number;
  meanCertaintyLeft: number;
  /** Certainty lost per fight, by cause. */
  meanCertaintyLost: { blocked: number; decoys: number; misses: number; attacks: number; turnLimit: number };
  strikes: { meanPerFight: number; wrongShare: number };
  /** For each structure that was ever deployed: how often, and how often those fights were won. */
  structures: Partial<Record<StructureKind, { deployedShare: number; winRateWhenDeployed: number }>>;
  /** For each structure that ever answered: how often its range held the truth, against what it claimed. */
  accuracy: Partial<Record<StructureKind, { answers: number; withinRange: number; statedConfidence: number; meanRelativeError: number | null }>>;
}

export interface ReportMeta {
  bot: string;
  tier: string;
  loadout: string;
  seedBase: number;
}

const sum = (records: FightRecord[], pick: (record: FightRecord) => number) => records.reduce((total, record) => total + pick(record), 0);

/** Combines many fight records into one report. */
export function summarize(records: FightRecord[], meta: ReportMeta): FightReport {
  const n = records.length;
  if (n === 0) throw new RangeError("Cannot summarize zero fights");
  const mean = (pick: (record: FightRecord) => number) => sum(records, pick) / n;

  const won = records.filter((record) => record.outcome === "won").length;
  const totalStrikes = sum(records, (record) => record.strikes.total);

  const structures: FightReport["structures"] = {};
  for (const kind of STRUCTURE_KINDS) {
    const deployedIn = records.filter((record) => record.deployed.includes(kind));
    if (deployedIn.length === 0) continue;
    structures[kind] = {
      deployedShare: deployedIn.length / n,
      winRateWhenDeployed: deployedIn.filter((record) => record.outcome === "won").length / deployedIn.length,
    };
  }

  const accuracy: FightReport["accuracy"] = {};
  for (const kind of STRUCTURE_KINDS) {
    const tally: AccuracyTally = { answers: 0, covered: 0, confidenceSum: 0, relativeErrorSum: 0, relativeErrorCount: 0 };
    for (const record of records) {
      const part = record.accuracy[kind];
      if (!part) continue;
      tally.answers += part.answers;
      tally.covered += part.covered;
      tally.confidenceSum += part.confidenceSum;
      tally.relativeErrorSum += part.relativeErrorSum;
      tally.relativeErrorCount += part.relativeErrorCount;
    }
    if (tally.answers === 0) continue;
    accuracy[kind] = {
      answers: tally.answers,
      withinRange: tally.covered / tally.answers,
      statedConfidence: tally.confidenceSum / tally.answers,
      meanRelativeError: tally.relativeErrorCount > 0 ? tally.relativeErrorSum / tally.relativeErrorCount : null,
    };
  }

  return {
    ...meta,
    fights: n,
    outcomes: {
      won,
      lost: records.filter((record) => record.outcome === "lost").length,
      stalled: records.filter((record) => record.outcome === "stalled").length,
      lostToTurnLimit: records.filter((record) => record.reason === "turnLimit").length,
      lostToCertainty: records.filter((record) => record.reason === "certainty").length,
    },
    winRate: won / n,
    winRateInterval: wilsonInterval(won, n),
    meanTurns: mean((record) => record.turns),
    meanCertaintyLeft: mean((record) => record.certaintyLeft),
    meanCertaintyLost: {
      blocked: mean((record) => record.certaintyLost.blocked),
      decoys: mean((record) => record.certaintyLost.decoys),
      misses: mean((record) => record.certaintyLost.misses),
      attacks: mean((record) => record.certaintyLost.attacks),
      turnLimit: mean((record) => record.certaintyLost.turnLimit),
    },
    strikes: {
      meanPerFight: totalStrikes / n,
      wrongShare: totalStrikes === 0 ? 0 : sum(records, (record) => record.strikes.wrong) / totalStrikes,
    },
    structures,
    accuracy,
  };
}

export interface RunOptions {
  bot: Bot;
  tier: TierName;
  loadout: LoadoutName;
  /** Number of fights. */
  n: number;
  /** Fight i uses the seed `seedBase + i`, so the same inputs always give the same report. */
  seedBase: number;
  maxSteps?: number;
}

/** Plays `n` seeded fights with one bot and summarizes them. */
export function runFights({ bot, tier, loadout, n, seedBase, maxSteps }: RunOptions): FightReport {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a whole number >= 1, got ${n}`);
  const records = Array.from({ length: n }, (_, i) => {
    const seed = String(seedBase + i);
    const config = buildFightConfig({ seed, tier, ...(loadout === "full" ? { loadout: [...STRUCTURE_KINDS] } : {}) });
    return playFight({ config, seed, bot, ...(maxSteps !== undefined ? { maxSteps } : {}) });
  });
  return summarize(records, { bot: bot.name, tier, loadout, seedBase });
}
