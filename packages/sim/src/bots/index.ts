import { cautious } from "./cautious";
import { greedy } from "./greedy";
import { oracle } from "./oracle";
import { prober } from "./prober";
import { random } from "./random";
import type { Bot } from "./types";

export type { Bot, BotPlayer, BotView } from "./types";

/** The five bots the spec names, weakest to strongest in the order it lists them. */
export const BOTS: Record<string, Bot> = { random, greedy, prober, cautious, oracle };

export function getBot(name: string): Bot {
  const bot = BOTS[name];
  if (!bot) throw new Error(`Unknown bot "${name}". Choose one of: ${Object.keys(BOTS).join(", ")}`);
  return bot;
}
