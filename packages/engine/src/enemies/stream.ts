import { murmur3String } from "../hash/murmur3";
import { Rng, type RngState } from "../rng/rng";
import type { StreamEvent } from "../structures/types";
import type { LiveSet } from "./liveSet";
import { makePermutation } from "./permutation";
import { createZipfSampler } from "./zipf";

export type TraitLevel = "low" | "medium" | "high";

export interface StreamTraits {
  variety: TraitLevel;
  skew: TraitLevel;
  churn: TraitLevel;
  growth: TraitLevel;
  drift: TraitLevel;
}

export interface DriftParams {
  /** Share of the top ranks that are reshuffled at each drift event. */
  fraction: number;
  /** A drift event happens on every turn divisible by this. 0 means never. */
  everyTurns: number;
}

/** What each trait level means as numbers. Comes from content (`traits.json`). */
export interface TraitTables {
  variety: Record<TraitLevel, number>;
  skew: Record<TraitLevel, number>;
  churn: Record<TraitLevel, number>;
  growth: Record<TraitLevel, number>;
  drift: Record<TraitLevel, DriftParams>;
}

/** An enemy's stream, fully described by numbers. */
export interface StreamParams {
  /** Number of distinct values the enemy can emit. */
  universe: number;
  /** Zipf exponent: 0 is uniform, larger values concentrate on a few values. */
  skew: number;
  /** Share of events that delete a live value. */
  churn: number;
  /** Burst size multiplier, compounding each turn. */
  growth: number;
  drift: DriftParams;
  /** Events in the first burst: Size / EXPECTED_TURNS. */
  baseBurst: number;
}

/** The part of the stream that changes over a fight. Plain data. */
export interface StreamState {
  seed: string;
  /** Bursts generated so far. */
  turn: number;
  /** Drift events applied so far. */
  driftEpochs: number;
  rng: RngState;
}

export function resolveStreamParams(
  size: number,
  traits: StreamTraits,
  tables: TraitTables,
  expectedTurns: number,
): StreamParams {
  return {
    universe: tables.variety[traits.variety],
    skew: tables.skew[traits.skew],
    churn: tables.churn[traits.churn],
    growth: tables.growth[traits.growth],
    drift: tables.drift[traits.drift],
    baseBurst: size / expectedTurns,
  };
}

export function createStream(seed: string): StreamState {
  return { seed, turn: 0, driftEpochs: 0, rng: Rng.fromSeed(`${seed}/stream`).getState() };
}

/**
 * Events in the burst for a turn (1 is the first): the base size, times the growth factor once per earlier turn.
 * The factor is built by repeated multiplication, which gives the same result on every JavaScript engine.
 */
export function burstSize(params: StreamParams, turn: number): number {
  let factor = 1;
  for (let i = 1; i < turn; i++) factor *= params.growth;
  return Math.max(1, Math.round(params.baseBurst * factor));
}

function driftDue(params: StreamParams, turn: number): boolean {
  return params.drift.everyTurns > 0 && params.drift.fraction > 0 && turn % params.drift.everyTurns === 0;
}

/** Number of top ranks reshuffled by a drift event. */
function driftBlock(params: StreamParams): number {
  return Math.min(params.universe, Math.max(1, Math.ceil(params.drift.fraction * params.universe)));
}

/**
 * Builds the function that turns a Zipf rank (0 is the heaviest) into a concrete value.
 *
 * Ranks go through a seeded permutation, then an affine map into uint32 space (an odd multiplier keeps it
 * one-to-one). Each drift event reshuffles the top block of ranks, so the heavy values change owners while
 * every rank still has a distinct value. Nothing is stored: the mapping is rebuilt from the seed and the
 * number of drift events.
 */
export function createRankMapper(params: StreamParams, seed: string, driftEpochs: number): (rank: number) => number {
  const order = makePermutation(params.universe, murmur3String(`${seed}/order`));
  const multiplier = murmur3String(`${seed}/multiplier`) | 1;
  const offset = murmur3String(`${seed}/offset`);

  const block = driftBlock(params);
  const reshuffles: Array<(x: number) => number> = [];
  for (let epoch = 1; epoch <= driftEpochs; epoch++) {
    reshuffles.push(makePermutation(block, murmur3String(`${seed}/drift-${epoch}`)));
  }

  return (rank) => {
    let index = rank;
    // The newest reshuffle applies first, then each older one, down to the original order.
    if (index < block) for (let i = reshuffles.length - 1; i >= 0; i--) index = (reshuffles[i] as (x: number) => number)(index);
    return (Math.imul(multiplier, order(index)) + offset) >>> 0;
  };
}

export function rankToValue(params: StreamParams, seed: string, driftEpochs: number, rank: number): number {
  return createRankMapper(params, seed, driftEpochs)(rank);
}

export interface Burst {
  state: StreamState;
  events: StreamEvent[];
}

/**
 * Generates the next turn's burst. Returns the new stream state and the events, and applies the events to
 * `live` (the caller's exact record of what is live). The input state is not modified.
 */
export function nextBurst(params: StreamParams, state: StreamState, live: LiveSet): Burst {
  const turn = state.turn + 1;
  const driftEpochs = state.driftEpochs + (driftDue(params, turn) ? 1 : 0);

  const rng = Rng.fromState(state.rng);
  const toValue = createRankMapper(params, state.seed, driftEpochs);
  const drawRank = createZipfSampler(params.universe, params.skew);

  const events: StreamEvent[] = [];
  for (let i = burstSize(params, turn); i > 0; i--) {
    if (params.churn > 0 && live.liveTotal > 0 && rng.float() < params.churn) {
      events.push({ op: "delete", value: live.deleteRandom(rng) as number });
    } else {
      const value = toValue(drawRank(rng) - 1);
      live.insert(value);
      events.push({ op: "insert", value });
    }
  }

  return { state: { seed: state.seed, turn, driftEpochs, rng: rng.getState() }, events };
}
