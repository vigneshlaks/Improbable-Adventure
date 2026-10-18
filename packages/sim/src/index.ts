export { counterErrors, countErrorTable, everSeen, type CounterErrors, type ErrorRow } from "./countDuel";
export { BOTS, getBot, type Bot, type BotPlayer, type BotView } from "./bots";
export { formatComparison, formatReport, percent } from "./format";
export { recordReplay, type RecordReplayOptions } from "./replayRecorder";
export { main, parseArgs, type CliResult } from "./cli";
export { runFights, summarize, type FightReport, type LoadoutName, type ReportMeta, type RunOptions } from "./report";
export { makeView, playFight, type AccuracyTally, type CountDuelTally, type FightRecord, type PlayOptions } from "./runner";
export { wilsonInterval } from "./stats";
