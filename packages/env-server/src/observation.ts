import { observeRun, STRUCTURE_KINDS, type Observation, type RunObservation, type RunState, type StructureView, type TraitLevel } from "@pda/engine";
import { SLOT_FEATURES, type Layout } from "./layout";

const LEVEL: Record<TraitLevel, number> = { low: 0, medium: 0.5, high: 1 };
const TRAITS = ["variety", "skew", "churn", "growth", "drift", "likeness"] as const;
const WEAK_POINTS = ["presence", "frequency", "count", "rank", "likeness"] as const;
const TIERS = ["minion", "elite", "boss"] as const;
const PHASES = ["fight", "reward", "rest"] as const;

/** Counts and sizes span orders of magnitude, so they are squashed: log(1 + x) / log(1 + scale), so `scale` maps to about 1. */
const squash = (x: number, scale: number): number => Math.min(1, Math.log1p(Math.max(0, x)) / Math.log1p(scale));
/** Where a number that can be huge is capped before it is squashed (an unbounded upper bound is reported as the cap). */
const COUNT_SCALE = 100_000;

const oneHot = <T extends string>(values: readonly T[], value: T | null | undefined): number[] => values.map((v) => (v === value ? 1 : 0));

/** One deployed structure: that it exists, what it is, its share of the Space, and what it answered. All between 0 and 1. */
function slotFeatures(view: StructureView | undefined, totalSpace: number, targets: readonly number[]): number[] {
  if (!view) return new Array<number>(SLOT_FEATURES).fill(0);
  const answer = view.answer;
  const numeric = answer && typeof answer.estimate === "number";
  const flagged = answer && Array.isArray(answer.estimate) ? answer.estimate.filter((t) => targets.includes(t)).length : 0;
  return [
    1,
    ...oneHot(STRUCTURE_KINDS, view.kind),
    view.spaceBits / Math.max(1, totalSpace),
    numeric ? 1 : 0,
    numeric ? squash(answer.estimate as number, COUNT_SCALE) : 0,
    numeric ? squash(answer.low, COUNT_SCALE) : 0,
    numeric ? (Number.isFinite(answer.high) ? squash(answer.high, COUNT_SCALE) : 1) : 0,
    answer ? answer.confidence : 0,
    targets.length > 0 ? flagged / targets.length : 0,
  ];
}

/**
 * The observation as a fixed-length vector of numbers between 0 and 1, built only from what a player can see
 * (`observeRun`) and the rules. The true answers are never in it. Anything that does not apply right now (a fight's
 * numbers between fights, the reward options during a fight) is zero.
 */
export function encodeObservation(state: RunState, layout: Layout): number[] {
  const run: RunObservation = observeRun(state);
  const fight: Observation | null = run.fight;
  const config = state.config;
  const enemy = config.encounters[Math.min(run.encounter, config.encounters.length - 1)];
  const out: number[] = [];

  // The run.
  out.push(...oneHot(PHASES, run.phase as (typeof PHASES)[number]));
  out.push(run.certainty / Math.max(1, run.maxCertainty), squash(run.maxCertainty, 1000), run.encounter / Math.max(1, run.encounters));
  out.push(...oneHot(TIERS, run.tier));
  out.push(...STRUCTURE_KINDS.map((kind) => (run.owned.includes(kind) ? 1 : 0)));
  out.push(...STRUCTURE_KINDS.map((kind) => (run.attached[kind] ? 1 : 0)));
  out.push(...layout.upgradeIds.map((id) => Math.min(1, (run.upgrades[id] ?? 0) / 5)));
  out.push(...layout.enchantmentIds.map((id) => Math.min(1, run.enchantments.filter((held) => held === id).length / 2)));

  // The fight.
  const totalSpace = fight ? fight.spaceFree + fight.structures.reduce((sum, view) => sum + view.spaceBits, 0) : 0;
  out.push(fight?.phase === "strike" ? 1 : 0, fight && enemy ? fight.turn / Math.max(1, enemy.turnLimit) : 0, fight && enemy ? fight.enemyHp / Math.max(1e-9, enemy.hp) : 0);
  out.push(squash(totalSpace, 100_000), fight ? fight.spaceFree / Math.max(1, totalSpace) : 0, fight && state.fight ? fight.slotsFree / Math.max(1, state.fight.slots.length) : 0);
  // How many of this turn's deploys and removals are left, as a share of what a turn allows: the agent can see its budget run out.
  out.push(fight && state.fight ? fight.changesLeft / Math.max(1, state.config.rules.changesPerSlot * state.fight.slots.length) : 0);
  out.push(...TRAITS.map((trait) => (fight ? LEVEL[fight.traits[trait]] : 0)));
  out.push(...oneHot([...WEAK_POINTS, "unknown"] as const, fight ? (fight.weakPoint ?? "unknown") : null));
  out.push(...oneHot(WEAK_POINTS, fight?.challenge?.kind));
  const targets = fight?.challenge?.kind === "presence" || fight?.challenge?.kind === "likeness" ? fight.challenge.targets : [];
  out.push(targets.length / Math.max(1, config.rules.presenceTargets), fight?.challenge?.kind === "frequency" ? 1 : 0, fight?.challenge?.kind === "count" ? 1 : 0);
  out.push(fight?.challenge?.kind === "rank" ? fight.challenge.quantile : 0); // how high the armor is, as a share
  for (let slot = 0; slot < layout.slots; slot++) out.push(...slotFeatures(fight?.structures.find((view) => view.slot === slot), totalSpace, targets));

  // The rewards on offer.
  for (let index = 0; index < layout.rewardChoices; index++) {
    const offer = run.offers?.[index];
    out.push(offer ? 1 : 0, ...layout.rewardIds.map((id) => (offer?.id === id ? 1 : 0)));
  }

  // The rest stop: which fusions and enchantments can be done.
  out.push(...layout.fusionIds.map((id) => (run.fusions?.some((fusion) => fusion.id === id) ? 1 : 0)));
  for (const spec of layout.actions) if (spec.type === "enchant") out.push(run.enchantable?.some((option) => option.enchantmentId === spec.enchantmentId && option.kind === spec.kind) ? 1 : 0);

  if (out.length !== layout.observationSize) throw new Error(`The observation has ${out.length} numbers, the layout says ${layout.observationSize}`);
  return out;
}
