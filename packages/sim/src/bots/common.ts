import { traits as traitData, weakPointWeights } from "@pda/content";
import type { Action, Observation, StreamTraits, StructureKind, StructureView, WeakPoint } from "@pda/engine";
import type { BotView } from "./types";

// Building blocks shared by the bots that deploy structures and strike on their answers.

const WEAK_POINTS: WeakPoint[] = ["presence", "frequency", "count", "rank", "likeness"];

/** The smallest Space worth giving a structure. */
const MIN_BITS = 256;

/** Structures that cannot be built in even that: a Top-K Tracker needs room for a Count-Min grid and a candidate list (a quarter of its Space, 96 bits an entry). */
const MIN_BITS_OF: Partial<Record<StructureKind, number>> = { topKTracker: 384, tDigest: 512, kllSketch: 1536, minHash: 256 };
const minBitsOf = (kind: StructureKind): number => Math.max(MIN_BITS, MIN_BITS_OF[kind] ?? 0);

/** Structures that suit each weak point, best first. Exact Memory and Reservoir Sampling answer anything. */
export function preferredKinds(weakPoint: WeakPoint, traits: StreamTraits): StructureKind[] {
  switch (weakPoint) {
    case "presence":
      // A Bloom Filter cannot delete, so under Churn it flags the deleted values as well; a Cuckoo Filter can forget them.
      // A Spectral Bloom Filter takes deletes back too, so it is the next choice under Churn; a Scalable Bloom Filter hedges against Growth.
      return traits.churn === "low"
        ? [...(traits.growth === "low" ? [] : (["scalableBloom"] as StructureKind[])), "bloomFilter", "spectralBloom", "exactMemory", "reservoirSampling"]
        : ["cuckooFilter", "bloomFilter", "spectralBloom", "exactMemory", "reservoirSampling"];
    case "frequency":
      // A Top-K Tracker follows the heavy values exactly, so it is worth having once the stream has some; on a flat stream nothing helps much.
      return traits.skew === "low"
        ? ["countMinSketch", "spectralBloom", "exactMemory", "reservoirSampling"]
        : ["topKTracker", "countMinSketch", "spectralBloom", "exactMemory", "reservoirSampling"];
    case "likeness":
      // MinHash is built for it. Exact Memory compares copies with its table exactly while the table has room.
      return ["minHash", "exactMemory"];
    case "rank":
      // Both are far sharper than a sample of the same Space. A t-digest wins at the extreme quantiles the tougher enemies ask for.
      return ["tDigest", "kllSketch", "reservoirSampling", "exactMemory"];
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
    if (match) return match;
  }
  return answers[0] ?? null;
}

/** For each deployed structure that answered a Presence or Likeness challenge, the positions (0-based) it flagged. */
export function flaggedBy(observation: Observation): Array<{ structure: StructureView; positions: number[] }> {
  const challenge = observation.challenge;
  if (challenge?.kind !== "presence" && challenge?.kind !== "likeness") return [];
  const positionOf = new Map(challenge.targets.map((target, position) => [target, position]));
  return observation.structures.flatMap((structure) =>
    structure.answer && Array.isArray(structure.answer.estimate)
      ? [{ structure, positions: structure.answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((a, b) => a - b) }]
      : [],
  );
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
