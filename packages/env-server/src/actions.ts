import { legalRunActions, observeRun, type Observation, type RunAction, type RunState } from "@pda/engine";
import { type ActionSpec, type Layout, type StrikeKind } from "./layout";

const key = (action: RunAction): string => JSON.stringify(action);

/** The positions (0-based, in the order the targets were shown) each structure flagged, in slot order; a structure that cannot answer Presence is left out. */
function flaggedPositions(fight: Observation): Array<{ slot: number; positions: number[] }> {
  if (fight.challenge?.kind !== "presence" && fight.challenge?.kind !== "likeness") return [];
  const positionOf = new Map(fight.challenge.targets.map((target, position) => [target, position]));
  return fight.structures.flatMap((view) =>
    view.answer && Array.isArray(view.answer.estimate) ? [{ slot: view.slot, positions: view.answer.estimate.flatMap((target) => positionOf.get(target) ?? []).sort((x, y) => x - y) }] : [],
  );
}

const numeric = (x: number): number | null => (Number.isFinite(x) ? Math.max(0, Math.round(x)) : null);

/** Turns a strike choice into an action, or null when it does not apply right now (no such answer, or it would strike nothing twice). */
function strikeAction(fight: Observation, how: StrikeKind, slot: number | undefined): RunAction | null {
  const challenge = fight.challenge;
  if (!challenge) return null;
  if (challenge.kind === "presence" || challenge.kind === "likeness") {
    const flagged = flaggedPositions(fight);
    const subset = (positions: number[]): RunAction | null => (positions.length > 0 ? { type: "strikeSubset", targets: positions } : null);
    switch (how) {
      case "none":
        return { type: "strikeSubset", targets: [] };
      case "flaggedAll":
        return subset([...new Set(flagged.flatMap((f) => f.positions))].sort((x, y) => x - y));
      case "confirmed": {
        const votes = new Map<number, number>();
        for (const { positions } of flagged) for (const position of positions) votes.set(position, (votes.get(position) ?? 0) + 1);
        return subset([...votes].filter(([, n]) => n >= 2).map(([position]) => position).sort((x, y) => x - y));
      }
      case "flaggedBy":
        return subset(flagged.find((f) => f.slot === slot)?.positions ?? []);
      default:
        return null;
    }
  }
  if (how === "force1") return { type: "strikeValue", value: 1 };
  if (how !== "estimate" && how !== "high" && how !== "low") return null;
  const answer = fight.structures.find((view) => view.slot === slot)?.answer;
  if (!answer || typeof answer.estimate !== "number") return null;
  const value = how === "estimate" ? numeric(answer.estimate) : how === "high" ? numeric(Math.ceil(answer.high)) : numeric(Math.floor(answer.low));
  return value === null ? null : { type: "strikeValue", value };
}

/** The action a spec stands for, given the fight as the player sees it (null outside a fight). */
function decodeSpec(state: RunState, spec: ActionSpec, fight: Observation | null): RunAction | null {
  if (state.phase === "won" || state.phase === "lost") return null;
  switch (spec.type) {
    case "endDeploy":
      return { type: "endDeploy" };
    case "remove":
      return { type: "remove", slot: spec.slot };
    case "deploy": {
      if (!fight) return null;
      const spaceBits = Math.floor(fight.spaceFree * spec.share);
      return spaceBits >= 1 ? { type: "deploy", slot: spec.slot, kind: spec.kind, spaceBits } : null;
    }
    case "strike":
      return fight && state.fight?.phase === "strike" ? strikeAction(fight, spec.how, spec.slot) : null;
    case "choose":
      return { type: "chooseReward", index: spec.index };
    case "fuse":
      return { type: "fuse", recipeId: spec.recipeId };
    case "enchant":
      return { type: "enchant", enchantmentId: spec.enchantmentId, kind: spec.kind };
    case "leave":
      return { type: "leaveRest" };
  }
}

/** The action an index stands for in this state, or null when it does not apply. Does not check legality; use `actionMask` for that. */
export function decodeAction(state: RunState, layout: Layout, index: number): RunAction | null {
  const spec = layout.actions[index];
  return spec ? decodeSpec(state, spec, state.fight ? observeRun(state).fight : null) : null;
}

/**
 * Which indices can be taken now. An index is on when it decodes to an action: deploys, removals, `endDeploy`, reward,
 * fuse, enchant and leave must be among the engine's own legal actions; a strike only has to be a sensible one (any
 * Frequency force or Count estimate, any set of Presence targets, is accepted by the engine).
 */
export function actionMask(state: RunState, layout: Layout): boolean[] {
  const mask = layout.actions.map(() => false);
  if (state.phase === "won" || state.phase === "lost") return mask;
  const legal = new Set(legalRunActions(state).map(key));
  const fight = state.fight ? observeRun(state).fight : null; // seen once, not once per action
  layout.actions.forEach((spec, index) => {
    const action = decodeSpec(state, spec, fight);
    if (action === null) return;
    mask[index] = spec.type === "strike" ? true : legal.has(key(action));
  });
  return mask;
}
