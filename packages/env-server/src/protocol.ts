import type { Replay } from "@pda/engine";
import { Env, type EnvOptions, type EnvStep } from "./env";

/**
 * N games played side by side. The agent sends one action per game and gets every game's next observation back in one
 * line, which keeps the cost of talking to Node small next to the cost of learning.
 */
export class Batch {
  private envs: Env[] = [];
  private seeds: string[] = [];
  /** Each game's latest reply, so a game that has ended can keep giving it back. */
  private last: EnvStep[] = [];

  constructor(private readonly options: EnvOptions = {}) {}

  /** What the agent needs to know before starting. */
  info() {
    const probe = new Env(this.options);
    return { obsSize: probe.layout.observationSize, nActions: probe.layout.actions.length, labels: probe.layout.labels };
  }

  /** Starts games: all of them when `indices` is left out (their number is the number of seeds), otherwise the ones named. */
  reset(seeds: string[], indices?: number[]): EnvStep[] {
    if (indices === undefined) {
      this.envs = seeds.map(() => new Env(this.options));
      this.seeds = [...seeds];
      this.last = this.envs.map((env, i) => env.reset(seeds[i] as string));
      return [...this.last];
    }
    if (indices.length !== seeds.length) throw new RangeError("Give one seed for each index");
    return indices.map((index, i) => {
      const env = this.envs[index];
      if (!env) throw new RangeError(`There is no game ${index}`);
      this.seeds[index] = seeds[i] as string;
      const first = env.reset(seeds[i] as string);
      this.last[index] = first;
      return first;
    });
  }

  /** One finished game as a replay that `pnpm sim replay verify` accepts. */
  replay(index: number): Replay {
    const replay = this.envs[index]?.replay();
    if (!replay) throw new RangeError(`Game ${index} has not ended in a win or a loss`);
    return replay;
  }

  step(actions: number[]): EnvStep[] {
    if (actions.length !== this.envs.length) throw new RangeError(`Expected ${this.envs.length} actions, got ${actions.length}`);
    // A game that has ended, or been cut off, ignores its action and repeats its last reply (with no reward) until it is reset.
    this.last = this.envs.map((env, i) => {
      const before = this.last[i] as EnvStep;
      return before.done || before.truncated ? { ...before, reward: 0 } : env.step(actions[i] as number);
    });
    return [...this.last];
  }
}

const pack = (steps: EnvStep[]) => ({
  obs: steps.map((s) => s.obs),
  masks: steps.map((s) => s.mask),
  rewards: steps.map((s) => s.reward),
  dones: steps.map((s) => s.done),
  truncated: steps.map((s) => s.truncated),
  won: steps.map((s) => s.won),
  turns: steps.map((s) => s.turns),
  certaintyLeft: steps.map((s) => s.certaintyLeft),
});

/** One line in, one line out. A bad request or an action the game refuses gives `{"error": "..."}` instead of ending the program. */
export function handleLine(batch: Batch, line: string): string {
  try {
    const request = JSON.parse(line) as { cmd?: string; seeds?: unknown; indices?: unknown; actions?: unknown; index?: unknown };
    switch (request.cmd) {
      case "info":
        return JSON.stringify(batch.info());
      case "reset": {
        const seeds = request.seeds;
        if (!Array.isArray(seeds) || !seeds.every((s) => typeof s === "string")) throw new TypeError('"seeds" must be a list of strings');
        const indices = request.indices;
        if (indices !== undefined && !(Array.isArray(indices) && indices.every((i) => Number.isInteger(i)))) throw new TypeError('"indices" must be a list of whole numbers');
        return JSON.stringify(pack(batch.reset(seeds as string[], indices as number[] | undefined)));
      }
      case "replay": {
        const index = (request as { index?: unknown }).index;
        if (!Number.isInteger(index)) throw new TypeError('"index" must be a whole number');
        return JSON.stringify({ replay: batch.replay(index as number) });
      }
      case "step": {
        const actions = request.actions;
        if (!Array.isArray(actions) || !actions.every((a) => Number.isInteger(a))) throw new TypeError('"actions" must be a list of whole numbers');
        return JSON.stringify(pack(batch.step(actions as number[])));
      }
      default:
        throw new TypeError(`Unknown command ${JSON.stringify(request.cmd)}`);
    }
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}
