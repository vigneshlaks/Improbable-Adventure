import { balance, buildRunConfig } from "@pda/content";
import { createRun, IllegalActionError, stepRun, turnsTaken, type RunConfig, type RunState } from "@pda/engine";
import { actionMask, decodeAction } from "./actions";
import { buildLayout, type Layout } from "./layout";
import { encodeObservation } from "./observation";
import { shapeReward, type RewardWeights } from "./reward";

export interface EnvOptions {
  /** Builds the run for a seed. Defaults to the game's own content. */
  makeConfig?: (seed: string) => RunConfig;
  weights?: RewardWeights;
  maxSlots?: number;
  /** Steps after which an episode is cut off. */
  maxSteps?: number;
}

export interface EnvStep {
  obs: number[];
  mask: boolean[];
  reward: number;
  /** The run ended (won or lost). */
  done: boolean;
  /** The episode was cut off at the step limit. */
  truncated: boolean;
  /** Set once the run has ended. */
  won: boolean;
  turns: number;
  certaintyLeft: number;
}

/** One game for a learning agent: reset with a seed, then step with action indices. */
export class Env {
  readonly layout: Layout;
  private state: RunState | null = null;
  private steps = 0;
  private readonly makeConfig: (seed: string) => RunConfig;
  private readonly weights: RewardWeights;
  private readonly maxSteps: number;

  constructor(options: EnvOptions = {}, layout?: Layout) {
    this.makeConfig = options.makeConfig ?? ((seed) => buildRunConfig({ seed }));
    this.weights = options.weights ?? balance.RL_REWARD;
    this.maxSteps = options.maxSteps ?? balance.RL_MAX_STEPS;
    this.layout = layout ?? buildLayout(this.makeConfig("layout"), options.maxSlots ?? balance.RL_MAX_SLOTS);
  }

  private view(reward: number, truncated: boolean): EnvStep {
    const state = this.state as RunState;
    const done = state.phase === "won" || state.phase === "lost";
    return {
      obs: encodeObservation(state, this.layout),
      mask: actionMask(state, this.layout),
      reward,
      done,
      truncated: truncated && !done,
      won: state.phase === "won",
      turns: done ? turnsTaken(state) : 0,
      certaintyLeft: done ? state.certainty : 0,
    };
  }

  reset(seed: string): EnvStep {
    this.state = createRun(seed, this.makeConfig(seed));
    this.steps = 0;
    return this.view(0, false);
  }

  step(index: number): EnvStep {
    if (!this.state || this.state.phase === "won" || this.state.phase === "lost") throw new Error("Reset the environment before stepping it");
    const action = decodeAction(this.state, this.layout, index);
    if (action === null) throw new IllegalActionError(`Action ${index} (${this.layout.labels[index] ?? "unknown"}) does not apply now`);
    const result = stepRun(this.state, action);
    this.state = result.state;
    this.steps++;
    return this.view(shapeReward(result.events, this.weights), this.steps >= this.maxSteps);
  }
}
