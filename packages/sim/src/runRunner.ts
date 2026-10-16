import {
  createRun,
  groundTruth,
  legalActions as fightActions,
  observe,
  observeRun,
  Rng,
  stepRun,
  type GameEvent,
  type RunAction,
  type RunConfig,
  type RunEvent,
  type RunState,
  type StructureKind,
} from "@pda/engine";
import type { Bot, BotPlayer, BotView } from "./bots/types";
import { sensiblePolicy } from "./runPolicy";
import { isWrongStrike } from "./runner";

export interface RunFightRecord {
  tier: string;
  /** "stalled" is only possible for the fight in progress when the run hit its step limit. */
  outcome: "won" | "lost" | "stalled";
  turns: number;
}

export interface RunRecord {
  bot: string;
  seed: string;
  outcome: "won" | "lost" | "stalled";
  /** The encounter the run ended on (counting from 0): the last one beaten if won, the one lost to otherwise. */
  encounterReached: number;
  fightsWon: number;
  fights: RunFightRecord[];
  turns: number;
  certaintyLeft: number;
  /** Ids of the rewards taken, in order. */
  rewards: string[];
  /** Ids of the fusions done. */
  fused: string[];
  owned: StructureKind[];
  upgrades: Record<string, number>;
  /** The first structure deployed in the run. */
  opener: StructureKind | null;
  /** Every kind of structure deployed at least once. */
  deployed: StructureKind[];
  strikes: { total: number; wrong: number };
}

export interface PlayRunOptions {
  config: RunConfig;
  seed: string;
  bot: Bot;
  /** Gives up on a run that has not ended after this many actions. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 20000;

/** What the fight-level bot sees at this point of the run's current fight. */
function fightView(state: RunState, bot: Bot): BotView {
  const fight = state.fight as NonNullable<RunState["fight"]>;
  return {
    observation: observe(fight),
    loadout: fight.config.loadout,
    legalActions: () => fightActions(fight),
    truth: bot.usesTruth ? groundTruth(fight) : null,
  };
}

/** Plays one whole run with a bot and summarizes what happened. */
export function playRun({ config, seed, bot, maxSteps = DEFAULT_MAX_STEPS }: PlayRunOptions): RunRecord {
  const policy = bot.runPolicy ?? sensiblePolicy;
  const rng = Rng.fromSeed(`${seed}/bot/${bot.name}`);
  let state = createRun(seed, config);
  let player: BotPlayer = bot.create();
  let playerFor = state.encounter; // a new fight-level player is made for each fight

  // `createRun` returns only the state, so the first fight's start is recorded here.
  const events: Array<GameEvent | RunEvent> = [{ type: "fightStarted", encounter: 0, tier: config.encounters[0]?.tier ?? "minion" }];
  let steps = 0;
  while (state.phase !== "won" && state.phase !== "lost" && steps < maxSteps) {
    let action: RunAction;
    if (state.phase === "fight") {
      if (playerFor !== state.encounter) {
        player = bot.create();
        playerFor = state.encounter;
      }
      action = player(fightView(state, bot), rng);
    } else if (state.phase === "reward") {
      action = { type: "chooseReward", index: policy.reward(observeRun(state).offers ?? [], rng) };
    } else {
      action = policy.rest(observeRun(state).fusions ?? [], rng);
    }
    try {
      const result = stepRun(state, action);
      state = result.state;
      events.push(...result.events);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`Bot "${bot.name}" took an illegal action ${JSON.stringify(action)} in encounter ${state.encounter}: ${why}`, { cause: error });
    }
    steps++;
  }

  const record: RunRecord = {
    bot: bot.name,
    seed,
    outcome: state.phase === "won" ? "won" : state.phase === "lost" ? "lost" : "stalled",
    encounterReached: state.encounter,
    fightsWon: 0,
    fights: [],
    turns: 0,
    certaintyLeft: state.certainty,
    rewards: [],
    fused: [],
    owned: [...state.owned],
    upgrades: { ...state.upgrades },
    opener: null,
    deployed: [],
    strikes: { total: 0, wrong: 0 },
  };

  const deployed = new Set<StructureKind>();
  for (const event of events) {
    switch (event.type) {
      case "fightStarted":
        record.fights.push({ tier: event.tier, outcome: "stalled", turns: 0 });
        break;
      case "fightWon": {
        const fight = record.fights.at(-1) as RunFightRecord;
        fight.outcome = "won";
        fight.turns = event.turn;
        record.fightsWon++;
        break;
      }
      case "fightLost": {
        const fight = record.fights.at(-1) as RunFightRecord;
        fight.outcome = "lost";
        fight.turns = event.turn;
        break;
      }
      case "structureDeployed":
        record.opener ??= event.kind;
        deployed.add(event.kind);
        break;
      case "strikeResolved":
        record.strikes.total++;
        if (isWrongStrike(event)) record.strikes.wrong++;
        break;
      case "rewardChosen":
        record.rewards.push(event.id);
        break;
      case "fused":
        record.fused.push(event.recipeId);
        break;
    }
  }
  record.deployed = [...deployed];
  record.turns = record.fights.reduce((sum, fight) => sum + fight.turns, 0);
  return record;
}
