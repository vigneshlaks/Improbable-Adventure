import { traits as traitData, weakPointWeights } from "@pda/content";
import type { Action, Observation, StreamTraits, StructureKind, StructureView, WeakPoint } from "@pda/engine";
import type { BotView } from "./types";

// Building blocks shared by the bots that deploy structures and strike on their answers.

const WEAK_POINTS: WeakPoint[] = ["presence", "frequency", "count", "rank", "likeness"];

/** The smallest Space worth giving a structure. */
const MIN_BITS = 256;

/** Structures that cannot be built in even that: a Top-K Tracker needs room for a Count-Min grid and a candidate list (a quarter of its Space, 96 bits an entry). */
const MIN_BITS_OF: Partial<Record<StructureKind, number>> = { topKTracker: 384, tDigest: 512, kllSketch: 1536, dyadicCountMin: 4096, simHash: 1024, hyperMinHash: 256, lsh: 256, minHash: 256 };
const minBitsOf = (kind: StructureKind): number => Math.max(MIN_BITS, MIN_BITS_OF[kind] ?? 0);

/** Structures that suit each weak point, best first. Exact Memory and Reservoir Sampling answer anything. */
export function preferredKinds(weakPoint: WeakPoint, traits: StreamTraits): StructureKind[] {
  switch (weakPoint) {
    case "presence":
      // A Bloom Filter cannot delete, so under Churn it flags the deleted values as well; a Cuckoo Filter can forget them.
      // A Spectral Bloom Filter takes deletes back too, so it is the next choice under Churn; a Scalable Bloom Filter hedges against Growth.
      return traits.churn === "low"
        ? [...(traits.growth === "low" ? [] : (["scalableBloom"] as StructureKind[])), "bloomFilter", "spectralBloom", "exactMemory", "reservoirSampling"]
        : ["cuckooFilter", "bloomFilter", "quotientFilter", "spectralBloom", "exactMemory", "reservoirSampling"];
    case "frequency":
      // A Top-K Tracker follows the heavy values exactly, so it is worth having once the stream has some; on a flat stream nothing helps much.
      return traits.skew === "low"
        ? ["countMinSketch", "spectralBloom", "exactMemory", "reservoirSampling"]
        : ["topKTracker", "countMinSketch", "spectralBloom", "exactMemory", "reservoirSampling"];
    case "likeness":
      // MinHash is built for it. Exact Memory compares copies with its table exactly while the table has room.
      return ["hyperMinHash", "minHash", "exactMemory", "simHash", "lsh"];
    case "rank":
      // Both are far sharper than a sample of the same Space. A t-digest wins at the extreme quantiles the tougher enemies ask for.
      return ["tDigest", "kllSketch", "dyadicCountMin", "reservoirSampling", "exactMemory"];
    case "count":
      // LogLog suits huge streams. Linear Counting is more precise while its bitmap has room.
      // HyperLogLog (made by fusing the two) is the best of both.
      return traits.variety === "high"
        ? ["hyperLogLog", "logLog", "linearCounting", "exactMemory", "reservoirSampling"]
        : ["hyperLogLog", "linearCounting", "logLog", "exactMemory", "reservoirSampling"];
  }
}

/** The weak points an enemy with these visible traits is most likely to have, likeliest first. */
export function likelyWeakPoints(traits: StreamTraits): WeakPoint[] {
  const weights = weakPointWeights(traits, traitData);
  return [...WEAK_POINTS].sort((a, b) => weights[b] - weights[a]); // ties keep the order above
}

/** The weak point once it is known, otherwise the two likeliest guesses. */
export function targetWeakPoints(observation: Observation): WeakPoint[] {
  return observation.weakPoint ? [observation.weakPoint] : likelyWeakPoints(observation.traits).slice(0, 2);
}

/** The structures to have deployed: for each target, its best `copies` owned structures. */
export function desiredKinds(view: BotView, targets: WeakPoint[], copies: number): StructureKind[] {
  const wanted: StructureKind[] = [];
  for (const target of targets) {
    const owned = preferredKinds(target, view.observation.traits).filter((kind) => view.loadout.includes(kind));
    for (const kind of owned.slice(0, copies)) if (!wanted.includes(kind)) wanted.push(kind);
  }
  return wanted.slice(0, totalSlots(view.observation));
}

const END_DEPLOY: Action = { type: "endDeploy" };

export function totalSlots(observation: Observation): number {
  return observation.structures.length + observation.slotsFree;
}

function firstFreeSlot(observation: Observation): number | null {
  const taken = new Set(observation.structures.map((structure) => structure.slot));
  for (let slot = 0; slot < totalSlots(observation); slot++) if (!taken.has(slot)) return slot;
  return null;
}

/**
 * One step towards having the wanted structures deployed: deploy the next missing one with an even share of the
 * free Space, make room by removing a structure that is not wanted, or finish deploying when nothing is left to do.
 */
export function nextDeployAction(view: BotView, wanted: StructureKind[]): Action {
  const { observation } = view;
  if (observation.secondTraits) return nextTwinDeployAction(view, wanted);
  const deployed = new Set(observation.structures.map((structure) => structure.kind));
  const missing = wanted.filter((kind) => !deployed.has(kind));
  if (missing.length === 0) return END_DEPLOY;

  const slot = firstFreeSlot(observation);
  const next = missing[0] as StructureKind;
  if (slot !== null && observation.spaceFree >= minBitsOf(next)) {
    const share = Math.max(minBitsOf(next), Math.floor(observation.spaceFree / missing.length));
    return { type: "deploy", slot, kind: next, spaceBits: Math.min(share, observation.spaceFree) };
  }
  const unwanted = observation.structures.find((structure) => !wanted.includes(structure.kind));
  return unwanted ? { type: "remove", slot: unwanted.slot } : END_DEPLOY;
}

/** The free slot that watches `source` (even slots the first enemy, odd the second) in a fight with two enemies. */
function firstFreeSlotFor(observation: Observation, source: 0 | 1): number | null {
  const taken = new Set(observation.structures.map((structure) => structure.slot));
  for (let slot = source; slot < totalSlots(observation); slot += 2) if (!taken.has(slot)) return slot;
  return null;
}

/**
 * In a fight with two enemies, a challenge is about both streams, so a structure is wanted on each enemy: one pair per wanted kind, with the Space
 * shared out evenly. A pair needs two slots, so only as many kinds as there are pairs of slots are wanted. A Merge enchantment on the kind makes the pair answer
 * for both streams (see `combineAnswers`); without it the bot adds the two answers up.
 */
function nextTwinDeployAction(view: BotView, wanted: StructureKind[]): Action {
  const { observation } = view;
  const pairs = wanted.slice(0, Math.max(1, Math.floor(totalSlots(observation) / 2)));
  const has = (kind: StructureKind, source: 0 | 1) => observation.structures.some((s) => s.kind === kind && s.source === source);
  const missing = pairs.flatMap((kind) => ([0, 1] as const).filter((source) => !has(kind, source)).map((source) => ({ kind, source })));
  if (missing.length === 0) return END_DEPLOY;
  const next = missing[0] as { kind: StructureKind; source: 0 | 1 };
  const slot = firstFreeSlotFor(observation, next.source);
  const share = Math.max(minBitsOf(next.kind), Math.floor(observation.spaceFree / missing.length));
  if (slot !== null && observation.spaceFree >= minBitsOf(next.kind)) return { type: "deploy", slot, kind: next.kind, spaceBits: Math.min(share, observation.spaceFree) };
  const unwanted = observation.structures.find((structure) => !pairs.includes(structure.kind));
  return unwanted ? { type: "remove", slot: unwanted.slot } : END_DEPLOY;
}

export interface Answered {
  structure: StructureView;
  estimate: number;
  low: number;
  high: number;
}

/** The deployed structures that gave a numeric answer to the open challenge. */
export function numericAnswers(observation: Observation): Answered[] {
  return observation.structures.flatMap((structure) =>
    structure.answer && typeof structure.answer.estimate === "number"
      ? [{ structure, estimate: structure.answer.estimate, low: structure.answer.low, high: structure.answer.high }]
      : [],
  );
}

/** The numeric answer from the best-suited structure that has one, using the preference order for the challenge. */
export function bestNumericAnswer(observation: Observation): Answered | null {
  const challenge = observation.challenge;
  if (!challenge || challenge.kind === "presence" || challenge.kind === "likeness") return null;
  const answers = numericAnswers(observation);
  for (const kind of preferredKinds(challenge.kind, observation.traits)) {
    const match = answers.find((answer) => answer.structure.kind === kind);
    if (match) return combineAnswers(observation, answers.filter((answer) => answer.structure.kind === kind));
  }
  return answers[0] ? combineAnswers(observation, [answers[0]]) : null;
}

/**
 * In a fight with two enemies the answer that counts is about both streams. A merged structure already gives it. Otherwise the answers of one kind
 * on the two enemies are added up: for Frequency that is the count in the union exactly (counts add), for Count it is an overcount by the values both
 * enemies send, and for Rank there is nothing to add, so the first answer stands. In a single fight, the first answer.
 */
export function combineAnswers(observation: Observation, ofOneKind: Answered[]): Answered {
  const first = ofOneKind[0] as Answered;
  if (!observation.secondTraits) return first;
  const merged = ofOneKind.find((answer) => answer.structure.merged);
  if (merged) return merged;
  const kind = observation.challenge?.kind;
  if (kind !== "frequency" && kind !== "count") return first;
  const bySource = [0, 1].flatMap((source) => {
    const match = ofOneKind.find((answer) => answer.structure.source === source);
    return match ? [match] : [];
  });
  if (bySource.length < 2) return first;
  const sum = (pick: (a: Answered) => number) => bySource.reduce((total, answer) => total + pick(answer), 0);
  return { structure: first.structure, estimate: sum((a) => a.estimate), low: sum((a) => a.low), high: sum((a) => a.high) };
}

/** For each deployed structure that answered a Presence or Likeness challenge, the positions (0-based) it flagged. */
export function flaggedBy(observation: Observation): Array<{ structure: StructureView; positions: number[] }> {
  const challenge = observation.challenge;
  if (challenge?.kind !== "presence" && challenge?.kind !== "likeness") return [];
  const positionOf = new Map(challenge.targets.map((target, position) => [target, position]));
  const found = observation.structures.flatMap((structure) =>
    structure.answer && Array.isArray(structure.answer.estimate)
      ? [{ structure, positions: structure.answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((a, b) => a - b) }]
      : [],
  );
  if (!observation.secondTraits) return found;
  // With two enemies the question is about both streams: what one kind flags on either enemy is flagged (a merged pair says the same twice).
  const byKind = new Map<StructureKind, { structure: StructureView; positions: Set<number> }>();
  for (const { structure, positions } of found) {
    const group = byKind.get(structure.kind) ?? { structure, positions: new Set<number>() };
    for (const position of positions) group.positions.add(position);
    byKind.set(structure.kind, group);
  }
  return [...byKind.values()].map(({ structure, positions }) => ({ structure, positions: [...positions].sort((a, b) => a - b) }));
}

/** Presence positions flagged by at least `votes` structures. */
export function flaggedAtLeast(observation: Observation, votes: number): number[] {
  const counts = new Map<number, number>();
  for (const { positions } of flaggedBy(observation)) for (const position of positions) counts.set(position, (counts.get(position) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= votes).map(([position]) => position).sort((a, b) => a - b);
}

/** A whole-number force or estimate from a number, never below zero. */
export const whole = (x: number, how: "round" | "ceil" | "floor" = "round"): number => Math.max(0, Math[how](x));

/** What to do when no structure can help: a presence strike of nothing, or a minimal number. */
export function blindStrike(observation: Observation): Action {
  return observation.challenge?.kind === "presence" || observation.challenge?.kind === "likeness" ? { type: "strikeSubset", targets: [] } : { type: "strikeValue", value: 1 };
}
