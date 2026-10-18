import { createRun, STRUCTURE_KINDS, stepRun, type GameEvent, type Replay, type RunState, type StreamTraits, type StructureKind } from "@pda/engine";
import { sizeBloom, sizeCountMin, sizeExact, sizeHyperLogLog, sizeLinearCounting, sizeLogLog, sizeReservoir, type SizingConstants, type Workload } from "./sizing";

/** What one strike showed, in words the field report can use. */
export interface StrikeNote {
  kind: "presence" | "frequency" | "count";
  good: boolean;
  /** What happened, with the numbers. */
  text: string;
}

export interface FightRecord {
  /** Counts from 1, as the player sees it. */
  number: number;
  tier: "minion" | "elite" | "boss";
  traits: StreamTraits;
  /** Events the enemy's stream is sized to emit. */
  streamSize: number;
  won: boolean;
  turns: number;
  /** The structures deployed when the fight ended. */
  deployed: StructureKind[];
  strikes: StrikeNote[];
}

export interface DeployRecord {
  fight: number;
  kind: StructureKind;
  spaceBits: number;
  knob?: number;
  streamSize: number;
}

/** What a finished run showed: every fight, every strike, every deployment. Found by playing the replay again. */
export interface RunAnalysis {
  seed: string;
  won: boolean;
  turns: number;
  certaintyLeft: number;
  owned: StructureKind[];
  /** Everything the player used: what they ended with, and what a fusion consumed along the way. In the order the game lists structures. */
  used: StructureKind[];
  fights: FightRecord[];
  deploys: DeployRecord[];
}

const round = (x: number) => Math.round(x * 100) / 100;

type StrikeEvent = Extract<GameEvent, { type: "strikeResolved" }>;

export function describeStrike(event: StrikeEvent): StrikeNote {
  if (event.kind === "presence") {
    const good = event.decoyHits === 0;
    const missed = event.realTotal - event.realHits;
    return { kind: "presence", good, text: `Struck ${event.realHits} of ${event.realTotal} real targets and ${event.decoyHits} decoy${event.decoyHits === 1 ? "" : "s"}${missed > 0 ? `, leaving ${missed} real one${missed === 1 ? "" : "s"} unstruck` : ""}.` };
  }
  if (event.kind === "frequency") {
    const ratio = event.trueCount > 0 ? event.force / event.trueCount : 0;
    if (event.outcome === "blocked") return { kind: "frequency", good: false, text: `Struck with force ${round(event.force)} against a true count of ${event.trueCount}: too weak, and it was blocked.` };
    return { kind: "frequency", good: ratio <= 2, text: ratio > 2 ? `Struck with force ${round(event.force)} against a true count of ${event.trueCount}: it landed, but more than double the count wastes most of the damage.` : `Struck with force ${round(event.force)} against a true count of ${event.trueCount}.` };
  }
  const error = event.trueDistinct > 0 ? Math.abs(event.estimate - event.trueDistinct) / event.trueDistinct : 0;
  return { kind: "count", good: event.outcome === "hit", text: `Estimated ${round(event.estimate)} distinct values against a true ${event.trueDistinct} (${Math.round(error * 100)}% off)${event.outcome === "miss" ? ", too far to hurt" : ""}.` };
}

/** Plays the replay again and collects what happened. The replay is assumed to have been verified. */
export function analyzeRun(replay: Replay): RunAnalysis {
  let state: RunState = createRun(replay.seed, replay.config);
  const fights: FightRecord[] = [];
  const deploys: DeployRecord[] = [];
  let slots = new Map<number, StructureKind>();
  const startFight = (encounter: number): FightRecord => {
    const enemy = replay.config.encounters[encounter];
    if (!enemy) throw new Error(`The replay has no encounter ${encounter}`);
    const fight: FightRecord = { number: encounter + 1, tier: enemy.tier, traits: enemy.traits, streamSize: enemy.size, won: false, turns: 0, deployed: [], strikes: [] };
    fights.push(fight);
    slots = new Map();
    return fight;
  };
  let current: FightRecord = startFight(0); // the first fight begins with the run, so it has no event of its own

  for (const action of replay.actions) {
    const result = stepRun(state, action);
    for (const event of result.events) {
      switch (event.type) {
        case "fightStarted":
          current = startFight(event.encounter);
          break;
        case "structureDeployed":
          slots.set(event.slot, event.kind);
          if (action.type === "deploy") deploys.push({ fight: current.number, kind: event.kind, spaceBits: event.spaceBits, ...(action.knob === undefined ? {} : { knob: action.knob }), streamSize: current.streamSize });
          break;
        case "structureRemoved":
          slots.delete(event.slot);
          break;
        case "strikeResolved":
          current.strikes.push(describeStrike(event));
          break;
        case "fightWon":
        case "fightLost":
          current.won = event.type === "fightWon";
          current.turns = event.turn;
          current.deployed = [...new Set(slots.values())];
          break;
        default:
          break;
      }
    }
    state = result.state;
  }
  const seen = new Set<StructureKind>([...state.owned, ...state.consumed, ...deploys.map((deploy) => deploy.kind)]);
  return { seed: replay.seed, won: state.phase === "won", turns: replay.claimed.turns, certaintyLeft: replay.claimed.certaintyLeft, owned: [...state.owned], used: STRUCTURE_KINDS.filter((kind) => seen.has(kind)), fights, deploys };
}

/** How one kind of structure was sized in the run, against what production-grade sizing asks for the same stream. */
export interface ProfileEntry {
  kind: StructureKind;
  deploys: number;
  meanSpaceBits: number;
  /** The Space the player gave, divided by the Space that reaches the default target error for that stream (1 is production-grade, below 1 is tighter). */
  spaceRatio: number;
}

/** The Space production-grade sizing needs for a workload at the default error (its own error and memory are ignored). */
export function productionBits(kind: StructureKind, { items, distinct }: Pick<Workload, "items" | "distinct">, constants: SizingConstants): number {
  const workload: Workload = { items, distinct };
  switch (kind) {
    case "bloomFilter":
      return sizeBloom(workload, constants).memoryBits;
    case "countMinSketch":
      return sizeCountMin(workload, constants).memoryBits;
    case "hyperLogLog":
      return sizeHyperLogLog(workload, constants).memoryBits;
    case "logLog":
      return sizeLogLog(workload, constants).memoryBits;
    case "linearCounting":
      return sizeLinearCounting(workload, constants).memoryBits;
    case "reservoirSampling":
      return sizeReservoir(workload, constants).memoryBits;
    case "exactMemory":
      return sizeExact(workload, constants).memoryBits;
  }
}

/**
 * The player's tradeoff profile: for each structure they deployed, how tight they ran it compared with production-grade
 * sizing. A ratio under 1 means they accepted more error than the default target to fit the game's budget.
 */
export function tradeoffProfile(analysis: RunAnalysis, constants: SizingConstants): ProfileEntry[] {
  const kinds = [...new Set(analysis.deploys.map((deploy) => deploy.kind))];
  return kinds.map((kind) => {
    const mine = analysis.deploys.filter((deploy) => deploy.kind === kind);
    const ratios = mine.map((deploy) => deploy.spaceBits / productionBits(kind, { items: deploy.streamSize, distinct: deploy.streamSize }, constants));
    return {
      kind,
      deploys: mine.length,
      meanSpaceBits: mine.reduce((sum, deploy) => sum + deploy.spaceBits, 0) / mine.length,
      spaceRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    };
  });
}
