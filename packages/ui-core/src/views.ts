import { findStructure, narration, structures } from "@pda/content";
import { STRUCTURE_KINDS, type Answer, type Observation, type StructureView } from "@pda/engine";
import { formatNumber, TRAIT_NAMES, title } from "./narrator";

// The layouts of the status, query and help screens. Story text lives in content; these are the displays.

const PHASES = { deploy: "deploy phase", strike: "strike phase", won: "victory", lost: "defeat" } as const;
const nameOf = (view: StructureView) => structures[view.kind].name;
const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function renderStatus(observation: Observation): string[] {
  const traits = TRAIT_NAMES.flatMap((trait) =>
    observation.traits[trait] === "low" ? [] : [`  ${title(trait)} (${observation.traits[trait]})`],
  );
  return [
    `Turn ${observation.turn}, ${PHASES[observation.phase]}`,
    `Certainty: ${formatNumber(observation.certainty)}`,
    `Enemy HP: ${formatNumber(observation.enemyHp)}`,
    `Space: ${observation.spaceFree} bits free. Slots: ${observation.slotsFree} free.`,
    `Weak point: ${observation.weakPoint ?? "unknown"}`,
    ...(traits.length > 0 ? ["Enemy stream:", ...traits] : []),
    ...(observation.structures.length > 0
      ? ["Structures:", ...observation.structures.map((view) => `  ${view.slot + 1}. ${nameOf(view)} (${view.spaceBits} bits)`)]
      : ["No structures deployed."]),
  ];
}

function describeNumber(answer: Answer): string {
  const estimate = formatNumber(answer.estimate as number);
  const range =
    answer.high === Infinity
      ? `at least ${formatNumber(answer.low)}, no upper limit`
      : `likely between ${formatNumber(answer.low)} and ${formatNumber(answer.high)}`;
  return `about ${estimate} (${range}, ${percent(answer.confidence)} confidence)`;
}

/** Which Presence targets (as 0-based positions) each structure flagged, keyed by structure view. */
function flagged(observation: Observation, targets: readonly number[]): Map<StructureView, number[]> {
  const positionOf = new Map(targets.map((target, position) => [target, position]));
  const result = new Map<StructureView, number[]>();
  for (const view of observation.structures) {
    if (view.answer && Array.isArray(view.answer.estimate)) {
      result.set(view, view.answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((a, b) => a - b));
    }
  }
  return result;
}

/** What the player's structures say about the open challenge. */
export function renderQuery(observation: Observation): string[] {
  const challenge = observation.challenge;
  if (!challenge || observation.phase !== "strike") {
    return ['There is nothing to ask about yet. Type "ready" to let the stream arrive.'];
  }

  const lines: string[] = [];
  if (challenge.kind === "presence") {
    const byStructure = flagged(observation, challenge.targets);
    lines.push("Targets:");
    challenge.targets.forEach((target, position) => {
      const slots = [...byStructure].filter(([, positions]) => positions.includes(position)).map(([view]) => view.slot + 1);
      const mark =
        slots.length === 0 ? "" : `   flagged by ${slots.length === 1 ? "slot" : "slots"} ${slots.join(", ")}${slots.length >= 2 ? " (confirmed)" : ""}`;
      lines.push(`  ${position + 1}) ${target}${mark}`);
    });
  } else if (challenge.kind === "frequency") {
    lines.push(`Shield on the value ${challenge.value}: how many times has it appeared?`);
  } else {
    lines.push("Estimate how many distinct values are in the stream right now.");
  }

  if (observation.structures.length === 0) return [...lines, "No structures deployed."];
  for (const view of observation.structures) {
    const prefix = `[${view.slot + 1}] ${nameOf(view)}:`;
    const answer = view.answer;
    if (!answer) lines.push(`${prefix} cannot answer this question`);
    else if (Array.isArray(answer.estimate)) {
      lines.push(`${prefix} flags ${plural(answer.estimate.length, "target")}; between ${answer.low} and ${answer.high} of the targets are real`);
    } else lines.push(`${prefix} ${describeNumber(answer)}`);
  }
  return lines;
}

function structureHelp(kind: keyof typeof structures): string[] {
  const info = structures[kind];
  return [
    `${info.name}: ${info.summary}`,
    info.help,
    `Answers: ${info.answers.join(", ")}.`,
    ...(info.knob ? [`Knob: ${info.knob.name} (${info.knob.min} to ${info.knob.max}). ${info.knob.description}`] : []),
    `Short names: ${info.aliases.join(", ")}.`,
    info.flavor,
  ];
}

/** Explains the commands and structures. With a topic, explains just that one. */
export function renderHelp(topic?: string): string[] {
  if (topic === undefined) {
    return [
      "Commands:",
      ...Object.values(narration.commands).map((command) => `  ${command.usage}: ${command.summary}`),
      "Structures:",
      ...STRUCTURE_KINDS.map((kind) => `  ${structures[kind].aliases[0]}: ${structures[kind].name}. ${structures[kind].summary}`),
      'Type "help <command or structure>" for more.',
    ];
  }

  const wanted = topic.trim().toLowerCase();
  const command = (narration.commands as Record<string, { usage: string; summary: string }>)[wanted];
  if (command) return [command.usage, command.summary];

  const kind = findStructure(wanted);
  if (kind) return structureHelp(kind);
  return [`No help for "${topic}". Type "help" to see everything.`];
}
