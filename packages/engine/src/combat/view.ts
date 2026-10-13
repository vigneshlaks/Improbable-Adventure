import type { Answer, Challenge } from "../structures/types";
import { trueAnswer } from "./challenges";
import {
  liveSetOf,
  loadStructures,
  slotsFree,
  spaceFree,
  deployProblem,
} from "./internal";
import type { Action, FightState, GroundTruth, Observation, StructureView } from "./types";

/** Everything the player may see right now. The true answers are never included. */
export function observe(state: FightState): Observation {
  const structures = loadStructures(state);
  const challenge = state.phase === "strike" ? state.challenge : null;

  const views: StructureView[] = [];
  state.slots.forEach((snapshot, slot) => {
    const structure = structures[slot];
    if (!snapshot || !structure) return;
    views.push({
      slot,
      kind: snapshot.kind,
      params: structure.params,
      spaceBits: snapshot.spaceBits,
      answer: challenge ? structure.query(challenge) : null,
    });
  });

  return {
    turn: state.turn,
    phase: state.phase,
    certainty: state.certainty,
    enemyHp: state.enemyHp,
    spaceFree: spaceFree(state),
    slotsFree: slotsFree(state),
    traits: state.config.enemy.traits,
    weakPoint: state.weakPoint,
    challenge,
    structures: views,
  };
}

/** The real answers, for bots and tests. This is not part of what a player sees. */
export function groundTruth(state: FightState): GroundTruth {
  const live = liveSetOf(state);
  return {
    frequency: live.mode(),
    distinct: live.distinct,
    answer: state.phase === "strike" && state.challenge ? trueAnswer(state.challenge, live) : null,
  };
}

/** Space shares offered when listing deploy options, as fractions of the free Space. */
const DEPLOY_SHARES = [0.25, 0.5, 0.75, 1];

function deployOptions(state: FightState): Action[] {
  const options: Action[] = [];
  const free = spaceFree(state);
  state.slots.forEach((snapshot, slot) => {
    if (snapshot) {
      options.push({ type: "remove", slot });
      return;
    }
    for (const kind of state.config.loadout) {
      const sizes = new Set(DEPLOY_SHARES.map((share) => Math.floor(free * share)).filter((bits) => bits >= 1));
      for (const spaceBits of sizes) {
        const action: Action = { type: "deploy", slot, kind, spaceBits };
        if (deployProblem(state, action) === null) options.push(action);
      }
    }
  });
  return options;
}

function numericCandidates(answers: Answer[]): number[] {
  const values = new Set<number>([1]); // a minimal force is always on offer
  for (const answer of answers) {
    if (typeof answer.estimate === "number" && Number.isFinite(answer.estimate)) values.add(Math.max(0, Math.round(answer.estimate)));
    if (Number.isFinite(answer.high)) values.add(Math.max(0, Math.ceil(answer.high)));
    if (Number.isFinite(answer.low)) values.add(Math.max(0, Math.floor(answer.low)));
  }
  return [...values].sort((a, b) => a - b);
}

function strikeOptions(state: FightState, challenge: Challenge): Action[] {
  const views = observe(state).structures;
  const answers = views.flatMap((view) => (view.answer ? [view.answer] : []));

  if (challenge.kind !== "presence") {
    return numericCandidates(answers).map((value) => ({ type: "strikeValue", value }));
  }

  // Presence: strike nothing, everything one structure flagged, or only targets flagged by two or more.
  const positionOf = new Map(challenge.targets.map((target, position) => [target, position]));
  const flaggedBy = answers.map((answer) =>
    Array.isArray(answer.estimate) ? answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((a, b) => a - b) : [],
  );
  const votes = new Map<number, number>();
  for (const flagged of flaggedBy) for (const position of flagged) votes.set(position, (votes.get(position) ?? 0) + 1);
  const confirmed = [...votes].filter(([, count]) => count >= 2).map(([position]) => position).sort((a, b) => a - b);

  const unique = new Map<string, number[]>();
  for (const targets of [[], ...flaggedBy, confirmed]) unique.set(targets.join(","), targets);
  return [...unique.values()].map((targets) => ({ type: "strikeSubset", targets }));
}

/**
 * A finite, representative set of actions that `step` accepts: deploy sizes at fixed shares of the free Space,
 * removals, and `endDeploy`, or strikes at each structure's estimate, upper and lower bound. `step` itself
 * accepts any valid value, so a human or bot may do more than this list shows.
 */
export function legalActions(state: FightState): Action[] {
  if (state.phase === "won" || state.phase === "lost") return [];
  if (state.phase === "deploy") return [...deployOptions(state), { type: "endDeploy" }];
  return state.challenge ? strikeOptions(state, state.challenge) : [];
}
