import { enchantments, findStructure, fusions, narration, structures, upgrades, variantName } from "@pda/content";
import { STRUCTURE_KINDS, type Answer, type Observation, type RewardView, type RunObservation, type StructureKind, type StructureView } from "@pda/engine";
import { formatNumber, TRAIT_NAMES, title } from "./narrator";

// The layouts of the status, query and help screens. Story text lives in content; these are the displays.

const PHASES = { deploy: "deploy phase", strike: "strike phase", won: "victory", lost: "defeat" } as const;
/** A structure's name with its enchantment: the variant it turns into, or its own name followed by the enchantment in brackets. */
export function structureLabel(kind: StructureKind, enchantment?: string): string {
  const own = structures[kind].name;
  if (enchantment === undefined) return own;
  const variant = variantName(own, kind, enchantment);
  return variant !== own ? variant : `${own} (${enchantments[enchantment]?.name ?? enchantment})`;
}
const nameOf = (view: StructureView) => structureLabel(view.kind, view.enchantment);
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
    `Space: ${observation.spaceFree} bits free. Slots: ${observation.slotsFree} free. Changes left this turn: ${observation.changesLeft}.`,
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
  } else if (challenge.kind === "rank") {
    lines.push(`Armor at rank ${formatNumber(challenge.quantile * 100)} percent: what value do that share of the stream's values sit at or below? Lower is blocked; far above it, little damage.`);
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

/**
 * Explains the commands and structures. With a topic, explains just that one. With a loadout, the overview lists only
 * the structures the player owns; asking about another one still explains it and says it is not owned.
 */
export function renderHelp(topic?: string, loadout?: readonly StructureKind[]): string[] {
  if (topic === undefined) {
    return [
      "Commands:",
      ...Object.values(narration.commands).map((command) => `  ${command.usage}: ${command.summary}`),
      "Structures:",
      ...STRUCTURE_KINDS.filter((kind) => !loadout || loadout.includes(kind)).map((kind) => `  ${structures[kind].aliases[0]}: ${structures[kind].name}. ${structures[kind].summary}`),
      'Type "help <command or structure>" for more.',
    ];
  }

  const wanted = topic.trim().toLowerCase();
  const command = (narration.commands as Record<string, { usage: string; summary: string }>)[wanted];
  if (command) return [command.usage, command.summary];

  const kind = findStructure(wanted);
  if (kind) return [...structureHelp(kind), ...(loadout && !loadout.includes(kind) ? ["You do not own this structure yet."] : [])];
  return [`No help for "${topic}". Type "help" to see everything.`];
}


/** The rewards on offer, numbered from 1 as the player types them. */
export function renderRewards(offers: readonly RewardView[]): string[] {
  return offers.map((offer, position) => {
    let text: string;
    if (offer.kind === "structure") text = `${structures[offer.structure].name} (new structure): ${structures[offer.structure].summary}`;
    else if (offer.kind === "enchantment") text = `${enchantments[offer.enchantment]?.name ?? offer.enchantment} (enchantment): ${enchantments[offer.enchantment]?.summary ?? ""}`;
    else text = `${upgrades[offer.upgrade]?.name ?? offer.upgrade} (upgrade): ${upgrades[offer.upgrade]?.summary ?? ""}`;
    return `  ${position + 1}) ${text}`;
  });
}

/** What can be done at a rest stop. */
export function renderRest(run: RunObservation): string[] {
  const available = run.fusions ?? [];
  const attachable = run.enchantable ?? [];
  if (available.length === 0 && attachable.length === 0) return ['Nothing to fuse or enchant. Type "leave" to go on to the next fight.'];

  const lines: string[] = [];
  if (available.length > 0) {
    lines.push(
      "Fusions you can do:",
      ...available.map((fusion) => {
        const info = fusions[fusion.id];
        const inputs = fusion.inputs.map((kind) => structures[kind].name).join(" and ");
        return `  ${info?.name ?? fusion.id}: ${inputs} become ${structures[fusion.result].name}. ${info?.summary ?? ""}`.trimEnd();
      }),
    );
  }
  if (attachable.length > 0) {
    const ids = [...new Set(attachable.map((option) => option.enchantmentId))];
    lines.push(
      "Enchantments you can attach:",
      ...ids.map((id) => {
        const fits = attachable.filter((option) => option.enchantmentId === id).map((option) => structures[option.kind].name);
        return `  ${enchantments[id]?.name ?? id} (fits: ${fits.join(", ")}): ${enchantments[id]?.summary ?? ""}`.trimEnd();
      }),
    );
  }
  const how = [
    ...(available.length > 0 ? ['"fuse <name>" to fuse (the originals are used up)'] : []),
    ...(attachable.length > 0 ? ['"enchant <enchantment> <structure>" to attach one (a structure holds one at a time)'] : []),
    '"leave" to go on to the next fight',
  ];
  lines.push(`Type ${how.join(", or ")}.`);
  return lines;
}

function enchantmentSummary(run: RunObservation): string {
  const name = (id: string) => enchantments[id]?.name ?? id;
  const onStructures = (Object.entries(run.attached) as Array<[StructureKind, string]>).map(([kind, id]) => `${name(id)} on ${structures[kind].name}`);
  const parts = [...onStructures.join(", ") ? [onStructures.join(", ")] : [], ...(run.enchantments.length > 0 ? [`in the pack: ${run.enchantments.map(name).join(", ")}`] : [])];
  return parts.length > 0 ? parts.join("; ") : "none";
}

/** Where the player is in the act, what they own, and (in a fight) the fight's own status. */
export function renderRunStatus(run: RunObservation): string[] {
  const taken = Object.entries(run.upgrades)
    .filter(([, times]) => times > 0)
    .map(([id, times]) => `${upgrades[id]?.name ?? id}${times > 1 ? ` x${times}` : ""}`);
  return [
    `Fight ${run.encounter + 1} of ${run.encounters} (${run.tier})`,
    `Certainty: ${formatNumber(run.certainty)} of ${formatNumber(run.maxCertainty)}`,
    `Owned: ${run.owned.map((kind) => structures[kind].name).join(", ")}`,
    `Upgrades: ${taken.length > 0 ? taken.join(", ") : "none"}`,
    `Enchantments: ${enchantmentSummary(run)}`,
    ...(run.fight ? renderStatus(run.fight).filter((line) => !line.startsWith("Certainty:")) : []),
  ];
}
