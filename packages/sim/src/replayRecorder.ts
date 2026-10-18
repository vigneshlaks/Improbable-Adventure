import { buildRunConfig, contentHash } from "@pda/content";
import { RunRecorder, type Replay, type RunConfig } from "@pda/engine";
import type { Bot } from "./bots/types";
import { playRun } from "./runRunner";

export interface RecordReplayOptions {
  bot: Bot;
  seed: string;
  /** The act to play. Defaults to the one the content designs from the seed. */
  config?: RunConfig;
  maxSteps?: number;
}

/** Plays a whole run with a bot and returns it as a replay. Throws if the run does not finish, since it would have no result to claim. */
export function recordReplay({ bot, seed, config = buildRunConfig({ seed }), maxSteps }: RecordReplayOptions): Replay {
  const recorder = new RunRecorder(seed, config, contentHash());
  playRun({ config, seed, bot, recorder, ...(maxSteps !== undefined ? { maxSteps } : {}) });
  return recorder.toReplay();
}
