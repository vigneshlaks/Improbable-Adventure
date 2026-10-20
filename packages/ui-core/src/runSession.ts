import { buildRunConfig, contentHash, narration, structureConstants } from "@pda/content";
import { IllegalActionError, observeRun, RunRecorder, type Replay, type RunObservation, type RunConfig, type RunEvent, type RunState } from "@pda/engine";
import { describeEnemy, formatNumber, narrateRunStep } from "./narrator";
import { parseRunCommand } from "./parser";
import { renderHelp, renderQuery, renderRest, renderRewards, renderRunStatus } from "./views";
import type { Session } from "./session";
import { structureVisual, type StructureVisual } from "./visuals";

export interface RunSessionOptions {
  seed: string;
  /** The act to play. Defaults to the one `buildRunConfig` designs from the seed; tests pass a changed one. */
  config?: RunConfig;
}

/** A run session also keeps what it needs to make a replay of the run once it has ended. */
export interface RunSession extends Session {
  /** The run as a replay, or null while it is still going or if the player left before the end. */
  replay(): Replay | null;
  /** What the side panel draws: one visual per deployed structure, empty outside a fight. */
  structures(): StructureVisual[];
  /** Commands that make sense right now, for buttons. */
  suggestions(): string[];
  /** What a player may see of the run right now. */
  observe(): RunObservation;
  /** The tier of every fight in the act, in order: all the player is told about a fight before it starts. */
  tiers(): Array<RunObservation["tier"]>;
}

/** A whole act played by typing lines. Like `Session` it holds no I/O, so a script of lines gives a transcript. */
export function createRunSession({ seed, config = buildRunConfig({ seed }) }: RunSessionOptions): RunSession {
  const recorder = new RunRecorder(seed, config, contentHash());
  let state: RunState = recorder.state;
  let quit = false;
  const over = () => quit || state.phase === "won" || state.phase === "lost";

  const firstFight: RunEvent = { type: "fightStarted", encounter: 0, encounters: config.encounters.length, tier: (config.encounters[0] as RunConfig["encounters"][number]).tier };

  /** The lines for the events of a step, with the enemy described whenever a fight starts. */
  function narrate(events: Parameters<typeof narrateRunStep>[0], listTargets: boolean): string[] {
    const lines: string[] = [];
    for (const event of events) {
      lines.push(...narrateRunStep([event], { listTargets }));
      if (event.type === "fightStarted") lines.push(...describeEnemy(config.encounters[event.encounter] as RunConfig["encounters"][number]));
    }
    return lines;
  }

  /** What the player needs to see next: the challenge and the answers, the rewards, or the rest stop. */
  function screen(): string[] {
    const run = observeRun(state);
    if (run.phase === "reward") return ["", ...renderRewards(run.offers ?? [])];
    if (run.phase === "rest") return ["", ...renderRest(run)];
    if (run.fight?.phase === "strike") return ["", ...renderQuery(run.fight)];
    return [];
  }

  return {
    replay: () => (state.phase === "won" || state.phase === "lost" ? recorder.toReplay() : null),

    structures() {
      const constants = structureConstants();
      return (state.fight?.slots ?? []).flatMap((snapshot, slot) => (snapshot ? [structureVisual(snapshot, slot, constants)] : []));
    },

    observe: () => observeRun(state),

    tiers: () => config.encounters.map((enemy) => enemy.tier),

    suggestions() {
      const run = observeRun(state);
      if (over()) return [];
      if (run.phase === "reward") return (run.offers ?? []).map((_, i) => `choose ${i + 1}`);
      if (run.phase === "rest") return ["leave", "status", "help"];
      return run.fight?.phase === "strike" ? ["query", "status", "help"] : ["status", "help"];
    },

    opening: () => [
      `Seed: ${seed}`,
      narration.game.runWelcome,
      "",
      ...narrate([firstFight], true),
      "",
      ...renderRunStatus(observeRun(state)),
    ],

    prompt() {
      const run = observeRun(state);
      const certainty = `Certainty ${formatNumber(run.certainty)}/${formatNumber(run.maxCertainty)}`;
      const place = `${run.encounter + 1}/${run.encounters}`;
      if (run.phase === "reward") return `[reward after fight ${place} | ${certainty}] > `;
      if (run.phase === "rest") return `[rest stop | ${certainty}] > `;
      const fight = run.fight;
      if (!fight) return "> ";
      return `[fight ${place} turn ${fight.turn} ${fight.phase === "strike" ? "strike" : "deploy"} | ${certainty} | Enemy HP ${formatNumber(fight.enemyHp)} | ${fight.spaceFree} bits free] > `;
    },

    handle(line) {
      if (over()) return { lines: [], done: true };
      const run = observeRun(state);
      const parsed = parseRunCommand(line, run);

      switch (parsed.kind) {
        case "empty":
          return { lines: [], done: false };
        case "error":
          return { lines: [parsed.message], done: false };
        case "quit":
          quit = true;
          return { lines: [narration.game.goodbye], done: true };
        case "info": {
          if (parsed.info === "status") return { lines: renderRunStatus(run), done: false };
          if (parsed.info === "help") return { lines: renderHelp(parsed.topic, state.owned), done: false };
          return { lines: run.fight ? renderQuery(run.fight) : ["There is nothing to ask about right now."], done: false };
        }
        case "action":
        case "runAction": {
          try {
            const result = recorder.step(parsed.action);
            state = result.state;
            // On a challenge turn the query screen lists the Presence targets with the structures' flags, so the story does not.
            const lines = [...(parsed.kind === "action" && parsed.note ? [parsed.note] : []), ...narrate(result.events, state.fight?.phase !== "strike")];
            return { lines: [...lines, ...screen()], story: lines, done: over() };
          } catch (error) {
            if (error instanceof IllegalActionError) return { lines: [error.message], done: false };
            throw error;
          }
        }
      }
    },
  };
}
