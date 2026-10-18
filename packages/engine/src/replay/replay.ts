import { IllegalActionError } from "../combat/types";
import { createRun, step, turnsTaken } from "../run/run";
import type { RunAction, RunConfig, RunState, RunStepResult } from "../run/types";

/**
 * The version of the rules. Bump it on any change to a rule, so a replay recorded under the old rules is not mistaken for a
 * forgery by the new ones: such a replay is reported as `version`, and verifies only against the engine that recorded it.
 */
export const ENGINE_VERSION = "2";

/** What a replay says happened. The verifier re-plays the run and checks every part of it. */
export interface ReplayClaim {
  won: boolean;
  /** Turns taken in all, counting every fight (the speedrun metric). */
  turns: number;
  certaintyLeft: number;
}

/** A whole run as plain data: the rules it ran under, its seed, and every action, so it is tiny to store and checked by re-playing. */
export interface Replay {
  engineVersion: string;
  /** A hash of the content the run was built from, so a replay can say which content it belongs to. */
  contentHash: string;
  seed: string;
  config: RunConfig;
  actions: RunAction[];
  claimed: ReplayClaim;
}

export type VerifyFailure = "malformed" | "version" | "content" | "illegal" | "incomplete" | "mismatch";

export type VerifyResult =
  | { ok: true; result: ReplayClaim }
  | { ok: false; reason: VerifyFailure; message: string; /** The action that was refused, counting from 0. */ step?: number };

const claimOf = (state: RunState): ReplayClaim => ({ won: state.phase === "won", turns: turnsTaken(state), certaintyLeft: state.certainty });
const finished = (state: RunState) => state.phase === "won" || state.phase === "lost";

/** Plays a run and keeps its actions, so that a finished run can be turned into a replay. An action the run refuses is not kept. */
export class RunRecorder {
  readonly actions: RunAction[] = [];
  private current: RunState;

  constructor(
    private readonly seed: string,
    private readonly config: RunConfig,
    private readonly contentHash: string,
  ) {
    this.current = createRun(seed, config);
  }

  get state(): RunState {
    return this.current;
  }

  step(action: RunAction): RunStepResult {
    const result = step(this.current, action);
    this.current = result.state;
    this.actions.push(action);
    return result;
  }

  toReplay(): Replay {
    if (!finished(this.current)) throw new Error("The run has not finished, so there is no result to claim yet");
    return {
      engineVersion: ENGINE_VERSION,
      contentHash: this.contentHash,
      seed: this.seed,
      config: this.config,
      actions: [...this.actions],
      claimed: claimOf(this.current),
    };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function shapeProblem(replay: unknown): string | null {
  if (!isObject(replay)) return "A replay is an object";
  for (const key of ["engineVersion", "contentHash", "seed"]) if (typeof replay[key] !== "string") return `"${key}" must be a string`;
  if (!isObject(replay.config) || !Array.isArray(replay.config.encounters)) return '"config" must be a run config';
  if (!Array.isArray(replay.actions)) return '"actions" must be a list';
  const claim = replay.claimed;
  if (!isObject(claim) || typeof claim.won !== "boolean" || typeof claim.turns !== "number" || typeof claim.certaintyLeft !== "number") {
    return '"claimed" must say whether the run was won, in how many turns, with how much Certainty left';
  }
  return null;
}

/**
 * Re-plays a replay from its seed and config. It rejects it if the engine version differs, if any action is refused, if it
 * stops before the run ends, or if the result it claims is not the result that comes out. Never throws, whatever it is given.
 */
export function verifyReplay(input: unknown, options: { contentHash?: string } = {}): VerifyResult {
  const problem = shapeProblem(input);
  if (problem) return { ok: false, reason: "malformed", message: problem };
  const replay = input as Replay;

  if (replay.engineVersion !== ENGINE_VERSION) {
    return { ok: false, reason: "version", message: `Recorded under engine ${replay.engineVersion}; this is engine ${ENGINE_VERSION}` };
  }
  if (options.contentHash !== undefined && replay.contentHash !== options.contentHash) {
    return { ok: false, reason: "content", message: "Recorded with different content than expected" };
  }

  let state: RunState;
  try {
    state = createRun(replay.seed, replay.config);
  } catch (error) {
    return { ok: false, reason: "malformed", message: error instanceof Error ? error.message : "The config cannot start a run" };
  }

  for (let index = 0; index < replay.actions.length; index++) {
    try {
      state = step(state, replay.actions[index] as RunAction).state;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action was refused";
      return { ok: false, reason: error instanceof IllegalActionError ? "illegal" : "malformed", message: `Action ${index}: ${message}`, step: index };
    }
  }
  if (!finished(state)) return { ok: false, reason: "incomplete", message: "The actions stop before the run ends" };

  const result = claimOf(state);
  const claim = replay.claimed;
  if (claim.won !== result.won || claim.turns !== result.turns || claim.certaintyLeft !== result.certaintyLeft) {
    return {
      ok: false,
      reason: "mismatch",
      message: `Claimed ${JSON.stringify(claim)} but the run gives ${JSON.stringify(result)}`,
    };
  }
  return { ok: true, result };
}

/** Orders two results for the speedrun: fewer turns first, ties broken by more Certainty left. Negative means `a` is better. */
export function compareSpeedruns(a: ReplayClaim, b: ReplayClaim): number {
  return a.turns - b.turns || b.certaintyLeft - a.certaintyLeft;
}

/** The runs that were won, best first. Runs that tie keep the order they were given in. */
export function rankSpeedruns<T extends { claimed: ReplayClaim }>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.claimed.won).sort((a, b) => compareSpeedruns(a.claimed, b.claimed));
}
