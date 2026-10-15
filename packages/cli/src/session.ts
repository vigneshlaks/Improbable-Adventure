import { buildFightConfig, narration, type TierName } from "@pda/content";
import {
  createFight,
  IllegalActionError,
  observe,
  step,
  STRUCTURE_KINDS,
  type FightState,
} from "@pda/engine";
import { describeEnemy, formatNumber, narrateEvents, parseCommand, renderHelp, renderQuery, renderStatus } from "@pda/ui-core";

export type LoadoutName = "starting" | "full";

export interface SessionOptions {
  seed: string;
  tier: TierName;
  loadout: LoadoutName;
}

export interface Reply {
  lines: string[];
  /** True once the fight is over or the player quit. */
  done: boolean;
}

/** One fight, played by typing lines. It holds no I/O, so a script of lines gives a transcript. */
export interface Session {
  opening(): string[];
  prompt(): string;
  handle(line: string): Reply;
}

export function createSession({ seed, tier, loadout }: SessionOptions): Session {
  const config = buildFightConfig({ seed, tier, ...(loadout === "full" ? { loadout: [...STRUCTURE_KINDS] } : {}) });
  let state: FightState = createFight(seed, config);
  let quit = false;
  const over = () => quit || state.phase === "won" || state.phase === "lost";

  return {
    opening: () => [`Seed: ${seed}`, ...describeEnemy(config.enemy), narration.game.welcome, "", ...renderStatus(observe(state))],

    prompt() {
      const o = observe(state);
      const phase = o.phase === "strike" ? "strike" : "deploy";
      return `[turn ${o.turn} ${phase} | Certainty ${formatNumber(o.certainty)} | Enemy HP ${formatNumber(o.enemyHp)} | ${o.spaceFree} bits free] > `;
    },

    handle(line) {
      if (over()) return { lines: [], done: true };
      const parsed = parseCommand(line, { observation: observe(state), loadout: config.loadout });

      switch (parsed.kind) {
        case "empty":
          return { lines: [], done: false };
        case "error":
          return { lines: [parsed.message], done: false };
        case "quit":
          quit = true;
          return { lines: [narration.game.goodbye], done: true };
        case "info": {
          const o = observe(state);
          const lines = parsed.info === "status" ? renderStatus(o) : parsed.info === "query" ? renderQuery(o) : renderHelp(parsed.topic, config.loadout);
          return { lines, done: false };
        }
        case "action": {
          try {
            const result = step(state, parsed.action);
            state = result.state;
            // On a challenge turn the query screen lists the Presence targets with the structures' flags, so the story does not.
            const lines = [...(parsed.note ? [parsed.note] : []), ...narrateEvents(result.events, { listTargets: state.phase !== "strike" })];
            if (state.phase === "strike") lines.push("", ...renderQuery(observe(state)));
            return { lines, done: over() };
          } catch (error) {
            if (error instanceof IllegalActionError) return { lines: [error.message], done: false };
            throw error;
          }
        }
      }
    },
  };
}
