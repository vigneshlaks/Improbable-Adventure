import {
  createFight,
  groundTruth,
  legalActions,
  observe,
  Rng,
  step,
  type FightConfig,
  type FightState,
  type GameEvent,
  type Observation,
  type StructureKind,
} from "@pda/engine";
import type { Bot, BotView } from "./bots/types";
import { counterErrors, everSeen } from "./countDuel";

/** What a bot sees at this point in the fight. The true answers are included only for a bot that asks for them. */
export function makeView(state: FightState, config: FightConfig, bot: Bot): BotView {
  return {
    observation: observe(state),
    loadout: config.loadout,
    legalActions: () => legalActions(state),
    truth: bot.usesTruth ? groundTruth(state) : null,
  };
}

/** How one kind of structure's answers compared with the truth, summed over a fight. */
export interface AccuracyTally {
  /** Answers given to a challenge. */
  answers: number;
  /** Answers whose stated range held the truth. */
  covered: number;
  /** The confidence the structures claimed, summed, so it can be averaged later. */
  confidenceSum: number;
  /** Relative error of the estimate, summed over the answers where it is defined. */
  relativeErrorSum: number;
  relativeErrorCount: number;
}

/** How LogLog and Linear Counting, given the same Space, compared at a fight's Count challenges. */
export interface CountDuelTally {
  /** Count challenges struck at. */
  challenges: number;
  /** Challenges where LogLog's estimate was strictly closer to the truth. */
  logLogCloser: number;
  /** The most distinct values the counters had seen at any one challenge (deleted values included). */
  largestDistinct: number;
}

export interface FightRecord {
  bot: string;
  seed: string;
  tier: string;
  /** "stalled" means the bot never finished within the step limit. */
  outcome: "won" | "lost" | "stalled";
  reason: "turnLimit" | "certainty" | null;
  turns: number;
  certaintyLeft: number;
  steps: number;
  /** Certainty lost, by what cost it. */
  certaintyLost: { blocked: number; decoys: number; misses: number; attacks: number; turnLimit: number };
  /** `wrong` counts strikes that were blocked, missed, or hit a decoy. */
  strikes: { total: number; wrong: number };
  /** Every structure the bot deployed, in order. */
  deployed: StructureKind[];
  /** Each kind of structure's answers against the truth. This is accuracy in play, so a structure deployed late is judged on a stream it only partly saw. */
  accuracy: Partial<Record<StructureKind, AccuracyTally>>;
  /** A side comparison, whatever the bot deployed: every Count structure the player could have used, at the starting Space. */
  countDuel: CountDuelTally;
  events?: GameEvent[];
}

/** Compares every structure's answer to the open challenge with the real answer, and adds it to the tallies. */
function tallyAnswers(observation: Observation, state: FightState, accuracy: FightRecord["accuracy"]): void {
  const truth = groundTruth(state).answer;
  if (!truth) return;
  // For Presence, the structures bound how many of the targets are real.
  const actual = truth.kind === "presence" ? truth.real.filter(Boolean).length : truth.kind === "frequency" ? truth.count : truth.distinct;

  for (const structure of observation.structures) {
    const answer = structure.answer;
    if (!answer) continue;
    const tally = (accuracy[structure.kind] ??= { answers: 0, covered: 0, confidenceSum: 0, relativeErrorSum: 0, relativeErrorCount: 0 });
    tally.answers++;
    tally.confidenceSum += answer.confidence;
    if (answer.low <= actual && actual <= answer.high) tally.covered++;
    if (typeof answer.estimate === "number" && actual > 0) {
      tally.relativeErrorSum += Math.abs(answer.estimate - actual) / actual;
      tally.relativeErrorCount++;
    }
  }
}

/** At a Count challenge, has a LogLog and a Linear Counting that each held all the starting Space judge the stream, and tallies who was closer. */
function tallyCountDuel(state: FightState, duel: CountDuelTally): void {
  const truth = groundTruth(state).answer;
  if (truth?.kind !== "count" || truth.distinct <= 0) return;
  const seen = everSeen(state.live);
  const errors = counterErrors(seen, truth.distinct, state.config.rules.startingSpace, state.config.constants);
  duel.challenges++;
  if (errors.logLog < errors.linearCounting) duel.logLogCloser++;
  duel.largestDistinct = Math.max(duel.largestDistinct, seen.length);
}

export interface PlayOptions {
  config: FightConfig;
  seed: string;
  bot: Bot;
  /** Gives up on a fight that has not ended after this many actions. */
  maxSteps?: number;
  keepEvents?: boolean;
}

/** Plays one whole fight with a bot and summarizes what happened. */
export function playFight({ config, seed, bot, maxSteps = 2000, keepEvents = false }: PlayOptions): FightRecord {
  let state = createFight(seed, config);
  const player = bot.create();
  const rng = Rng.fromSeed(`${seed}/bot/${bot.name}`);
  const all: GameEvent[] = [];
  const accuracy: FightRecord["accuracy"] = {};
  const countDuel: CountDuelTally = { challenges: 0, logLogCloser: 0, largestDistinct: 0 };

  let steps = 0;
  while (state.phase !== "won" && state.phase !== "lost" && steps < maxSteps) {
    const view = makeView(state, config, bot);
    if (state.phase === "strike") {
      tallyAnswers(view.observation, state, accuracy);
      tallyCountDuel(state, countDuel);
    }
    const action = player(view, rng);
    try {
      const result = step(state, action);
      state = result.state;
      all.push(...result.events);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`Bot "${bot.name}" took an illegal action ${JSON.stringify(action)} on turn ${state.turn}: ${why}`, { cause: error });
    }
    steps++;
  }

  const record: FightRecord = {
    bot: bot.name,
    seed,
    tier: config.enemy.tier,
    outcome: state.phase === "won" ? "won" : state.phase === "lost" ? "lost" : "stalled",
    reason: null,
    turns: state.turn,
    certaintyLeft: state.certainty,
    steps,
    certaintyLost: { blocked: 0, decoys: 0, misses: 0, attacks: 0, turnLimit: 0 },
    strikes: { total: 0, wrong: 0 },
    deployed: [],
    accuracy,
    countDuel,
  };

  for (const event of all) {
    switch (event.type) {
      case "structureDeployed":
        record.deployed.push(event.kind);
        break;
      case "enemyAttacked":
        record.certaintyLost.attacks += event.damage;
        break;
      case "strikeResolved":
        record.strikes.total++;
        if (event.kind === "frequency" && event.outcome === "blocked") record.certaintyLost.blocked += event.certaintyLost;
        if (event.kind === "count" && event.outcome === "miss") record.certaintyLost.misses += event.certaintyLost;
        if (event.kind === "presence") record.certaintyLost.decoys += event.certaintyLost;
        if (event.certaintyLost > 0 || (event.kind === "presence" && event.decoyHits > 0)) record.strikes.wrong++;
        break;
      case "fightLost":
        record.reason = event.reason;
        if (event.reason === "turnLimit") record.certaintyLost.turnLimit += event.certaintyLost;
        break;
    }
  }
  if (keepEvents) record.events = all;
  return record;
}
