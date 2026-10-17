import { findStructure, structures } from "@pda/content";
import type { Action, Observation, RunAction, RunObservation, StructureKind, StructureView } from "@pda/engine";

/** What a typed line means. Errors carry a message for the player; the parser never throws on bad input. */
export type ParseResult =
  | { kind: "action"; action: Action; note?: string }
  | { kind: "info"; info: "status" | "query" | "help"; topic?: string }
  | { kind: "quit" }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export interface ParseContext {
  observation: Observation;
  /** The structures the player owns. When given, deploying anything else is refused. */
  loadout?: readonly StructureKind[];
}

const COMMANDS = {
  deploy: "deploy",
  remove: "remove",
  ready: "ready",
  go: "ready",
  done: "ready",
  query: "query",
  strike: "strike",
  status: "status",
  help: "help",
  "?": "help",
  quit: "quit",
  exit: "quit",
  q: "quit",
} as const;

const error = (message: string): ParseResult => ({ kind: "error", message });
const isNumber = (token: string) => /^\d+(\.\d+)?$/.test(token);
const isWhole = (token: string) => /^\d+$/.test(token);

/** Edit distance between two short words, used to suggest what someone probably meant. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** The candidate closest to `word`, if it is close enough to be a likely typo. */
function closest(word: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const d = distance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** Why a command cannot be used in the current phase, or null if it can. */
function wrongPhase(observation: Observation, wanted: "deploy" | "strike"): string | null {
  if (observation.phase === "won" || observation.phase === "lost") return "The fight is over.";
  if (observation.phase === wanted) return null;
  if (wanted === "deploy") return 'The stream has arrived. Answer the challenge with "strike".';
  return 'There is no challenge yet. Type "ready" to let the stream arrive.';
}

function totalSlots(observation: Observation): number {
  return observation.structures.length + observation.slotsFree;
}

function firstFreeSlot(observation: Observation): number | null {
  const taken = new Set(observation.structures.map((view) => view.slot));
  for (let slot = 0; slot < totalSlots(observation); slot++) if (!taken.has(slot)) return slot;
  return null;
}

const nameOf = (view: StructureView) => structures[view.kind].name;

function parseDeploy(tokens: string[], { observation, loadout }: ParseContext): ParseResult {
  const usage = "Usage: deploy <structure> <bits> [knob]";
  const problem = wrongPhase(observation, "deploy");
  if (problem) return error(problem);

  // The structure's name is everything before the first number, so multi-word names work.
  const firstNumber = tokens.findIndex(isNumber);
  if (firstNumber < 1) return error(usage);
  const [bitsToken, knobToken, ...extra] = tokens.slice(firstNumber);
  if (extra.length > 0 || (knobToken !== undefined && !isNumber(knobToken))) return error(usage);

  const name = tokens.slice(0, firstNumber).join(" ");
  const kind = findStructure(name);
  if (!kind) {
    const aliases = Object.values(structures).flatMap((info) => info.aliases);
    const guess = closest(name, aliases);
    return error(
      `There is no structure called "${name}". ${guess ? `Did you mean "${guess}"?` : `Try one of: ${aliases.join(", ")}.`}`,
    );
  }
  const info = structures[kind];
  if (loadout && !loadout.includes(kind)) return error(`You do not own ${info.name}.`);

  if (!isWhole(bitsToken as string) || Number(bitsToken) < 1) return error("Space must be a whole number of bits, such as 4096.");
  const spaceBits = Number(bitsToken);
  if (spaceBits > observation.spaceFree) return error(`Only ${observation.spaceFree} bits of Space are free.`);

  const slot = firstFreeSlot(observation);
  if (slot === null) return error('Every slot is in use. Remove a structure first, for example "remove 1".');

  let knob: number | undefined;
  if (knobToken !== undefined) {
    if (!info.knob) return error(`${info.name} has no knob.`);
    knob = Number(knobToken);
    if (knob < info.knob.min || knob > info.knob.max) {
      return error(`The ${info.knob.name} must be between ${info.knob.min} and ${info.knob.max}.`);
    }
  }

  return { kind: "action", action: { type: "deploy", slot, kind, spaceBits, ...(knob !== undefined ? { knob } : {}) } };
}

function parseRemove(tokens: string[], { observation }: ParseContext): ParseResult {
  const problem = wrongPhase(observation, "deploy");
  if (problem) return error(problem);
  if (tokens.length !== 1 || !isWhole(tokens[0] as string)) return error("Usage: remove <slot>");

  const number = Number(tokens[0]);
  const total = totalSlots(observation);
  if (number < 1 || number > total) return error(`There is no slot ${number} (slots are numbered 1 to ${total}).`);
  if (!observation.structures.some((view) => view.slot === number - 1)) return error(`Slot ${number} is empty.`);
  return { kind: "action", action: { type: "remove", slot: number - 1 } };
}

/** The positions (0-based) of the Presence targets each structure flagged, one list per structure. */
function flaggedPositions(observation: Observation, targets: readonly number[]): number[][] {
  const positionOf = new Map(targets.map((target, position) => [target, position]));
  return observation.structures.flatMap((view) =>
    view.answer && Array.isArray(view.answer.estimate)
      ? [view.answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((a, b) => a - b)]
      : [],
  );
}

function strikePresence(tokens: string[], observation: Observation, targets: readonly number[]): ParseResult {
  const usage = 'Choose targets by number (for example "strike 1 3 4"), or "confirmed", "flagged" or "none".';
  const subset = (positions: number[], note?: string): ParseResult => ({
    kind: "action",
    action: { type: "strikeSubset", targets: positions },
    ...(note ? { note } : {}),
  });
  if (tokens.length === 0) return error(usage);

  if (tokens.length === 1 && tokens[0] === "none") return subset([]);
  if (tokens.length === 1 && (tokens[0] === "flagged" || tokens[0] === "confirmed")) {
    const lists = flaggedPositions(observation, targets);
    const votes = new Map<number, number>();
    for (const list of lists) for (const position of list) votes.set(position, (votes.get(position) ?? 0) + 1);
    const chosen = [...votes].filter(([, count]) => count >= (tokens[0] === "confirmed" ? 2 : 1)).map(([position]) => position);
    if (chosen.length === 0) {
      return error(
        tokens[0] === "confirmed"
          ? 'No target is flagged by two structures yet. Choose targets by number, or use "none".'
          : 'No structure has flagged any target. Choose targets by number, or use "none".',
      );
    }
    return subset(chosen.sort((a, b) => a - b));
  }

  if (!tokens.every(isWhole)) return error(usage);
  const positions: number[] = [];
  for (const token of tokens) {
    const number = Number(token);
    if (number < 1 || number > targets.length) {
      return error(`Target ${number} does not exist (targets are numbered 1 to ${targets.length}).`);
    }
    if (positions.includes(number - 1)) return error(`Target ${number} was listed twice.`);
    positions.push(number - 1);
  }
  return subset(positions);
}

function strikeNumber(tokens: string[], observation: Observation): ParseResult {
  const usage = 'Strike with a number (for example "strike 130"), or "estimate", "high" or "low".';
  const [first, second, ...extra] = tokens;
  const value = (amount: number, note?: string): ParseResult => ({
    kind: "action",
    action: { type: "strikeValue", value: amount },
    ...(note ? { note } : {}),
  });

  if (first === undefined || extra.length > 0) return error(usage);
  if (isNumber(first) && second === undefined) return value(Number(first));
  if (first !== "estimate" && first !== "high" && first !== "low") return error(usage);

  // Pick the structure whose answer to use: the one named, or the first that has a numeric answer.
  let source: StructureView | undefined;
  if (second !== undefined) {
    if (!isWhole(second)) return error(usage);
    source = observation.structures.find((view) => view.slot === Number(second) - 1);
    if (!source) return error(`There is no structure in slot ${second}.`);
    if (typeof source.answer?.estimate !== "number") return error(`${nameOf(source)} in slot ${second} has no answer to use.`);
  } else {
    source = observation.structures.find((view) => typeof view.answer?.estimate === "number");
    if (!source) return error("No deployed structure has an answer to use. Strike with a number instead.");
  }

  const answer = source.answer as NonNullable<StructureView["answer"]>;
  const bound = first === "estimate" ? answer.estimate : first === "high" ? answer.high : answer.low;
  if (typeof bound !== "number" || !Number.isFinite(bound)) {
    return error(`${nameOf(source)} gives no upper limit. Strike with a number or use "estimate".`);
  }
  const rounded = first === "high" ? Math.ceil(bound) : first === "low" ? Math.floor(bound) : Math.round(bound);
  return value(Math.max(0, rounded), `Using the ${nameOf(source)} in slot ${source.slot + 1}.`);
}

function parseStrike(tokens: string[], { observation }: ParseContext): ParseResult {
  const problem = wrongPhase(observation, "strike");
  if (problem) return error(problem);
  const challenge = observation.challenge;
  if (!challenge) return error('There is no challenge yet. Type "ready" to let the stream arrive.');
  return challenge.kind === "presence"
    ? strikePresence(tokens, observation, challenge.targets)
    : strikeNumber(tokens, observation);
}

/** Turns one typed line into an engine action, a request for information, or an explanation of what went wrong. */
export function parseCommand(input: string, context: ParseContext): ParseResult {
  const tokens = input.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const [word, ...rest] = tokens;
  if (word === undefined) return { kind: "empty" };

  const command = (COMMANDS as Record<string, string>)[word];
  switch (command) {
    case "deploy":
      return parseDeploy(rest, context);
    case "remove":
      return parseRemove(rest, context);
    case "ready": {
      const problem = wrongPhase(context.observation, "deploy");
      return problem ? error(problem) : { kind: "action", action: { type: "endDeploy" } };
    }
    case "strike":
      return parseStrike(rest, context);
    case "status":
      return { kind: "info", info: "status" };
    case "query":
      return { kind: "info", info: "query" };
    case "help":
      return rest.length > 0 ? { kind: "info", info: "help", topic: rest.join(" ") } : { kind: "info", info: "help" };
    case "quit":
      return { kind: "quit" };
    default: {
      const guess = closest(word, Object.keys(COMMANDS).filter((name) => name.length > 2));
      return error(`I don't know the command "${word}". ${guess ? `Did you mean "${guess}"? ` : ""}Type "help" to see the commands.`);
    }
  }
}


/** What a typed line means during a run: everything the fight parser knows, plus the choices between fights. */
export type RunParseResult = ParseResult | { kind: "runAction"; action: Extract<RunAction, { type: "chooseReward" | "fuse" | "leaveRest" }> };

const CHOOSE_WORDS = ["choose", "take", "pick"];
const LEAVE_WORDS = ["leave", "ready", "go", "done", "continue"];
const FIGHT_WORDS = ["deploy", "remove", "strike"];
const RUN_WORDS = [...CHOOSE_WORDS, "fuse", ...LEAVE_WORDS, ...FIGHT_WORDS];

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function parseChoose(tokens: string[], offers: number): RunParseResult {
  const usage = "Usage: choose <number>";
  if (tokens.length !== 1 || !isWhole(tokens[0] as string)) return error(usage);
  const number = Number(tokens[0]);
  if (number < 1 || number > offers) return error(`Choose a reward from 1 to ${offers}.`);
  return { kind: "runAction", action: { type: "chooseReward", index: number - 1 } };
}

function parseFuse(tokens: string[], run: RunObservation): RunParseResult {
  const fusions = run.fusions ?? [];
  const fuse = (recipeId: string): RunParseResult => ({ kind: "runAction", action: { type: "fuse", recipeId } });
  const available = fusions.map((fusion) => fusion.id).join(", ");
  if (tokens.length === 0) {
    if (fusions.length === 0) return error("There is nothing to fuse.");
    if (fusions.length > 1) return error(`Which fusion? Choose one of: ${available}.`);
    return fuse((fusions[0] as NonNullable<typeof fusions[number]>).id);
  }
  const wanted = tokens.join(" ");
  const kind = findStructure(wanted);
  const match = fusions.find((fusion) => normalize(fusion.id) === normalize(wanted) || (kind !== null && fusion.result === kind));
  if (match) return fuse(match.id);
  return error(fusions.length === 0 ? "There is nothing to fuse." : `There is no fusion called "${wanted}". Choose one of: ${available}.`);
}

/** Turns one typed line into an action for the run, a request for information, or an explanation. Never throws. */
export function parseRunCommand(input: string, run: RunObservation): RunParseResult {
  const tokens = input.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const [word, ...rest] = tokens;
  if (word === undefined) return { kind: "empty" };

  // These work everywhere.
  const common = (COMMANDS as Record<string, string>)[word];
  if (common === "quit") return { kind: "quit" };
  if (common === "status") return { kind: "info", info: "status" };
  if (common === "query") return { kind: "info", info: "query" };
  if (common === "help") return rest.length > 0 ? { kind: "info", info: "help", topic: rest.join(" ") } : { kind: "info", info: "help" };

  if (run.phase === "won" || run.phase === "lost") return error("The run is over.");

  if (run.phase === "fight") {
    if (CHOOSE_WORDS.includes(word)) return error("There is no reward to choose right now.");
    if (word === "fuse") return error("There is no rest stop to fuse at right now.");
    if (word === "leave" || word === "continue") return error("There is no rest stop to leave right now.");
    return parseCommand(input, { observation: run.fight as Observation, loadout: run.owned });
  }

  if (run.phase === "reward") {
    const offers = run.offers?.length ?? 0;
    if (CHOOSE_WORDS.includes(word)) return parseChoose(rest, offers);
    if (isWhole(word) && rest.length === 0) return parseChoose([word], offers);
    if (RUN_WORDS.includes(word)) return error('Choose a reward first, for example "choose 1".');
  } else {
    if (word === "fuse") return parseFuse(rest, run);
    if (LEAVE_WORDS.includes(word)) return { kind: "runAction", action: { type: "leaveRest" } };
    if (RUN_WORDS.includes(word) || isWhole(word)) return error('You are at a rest stop: "fuse" something, or "leave" to go on.');
  }

  const guess = closest(word, RUN_WORDS.filter((name) => name.length > 2));
  return error(`I don't know the command "${word}". ${guess ? `Did you mean "${guess}"? ` : ""}Type "help" to see the commands.`);
}
