import type { FusionDef, Rng, RewardView, RunAction } from "@pda/engine";

/** How a bot decides what the fight-level bots do not cover: which reward to take, and what to do at a rest stop. */
export interface RunPolicy {
  /** The index of the reward to take among those on offer. */
  reward(offers: readonly RewardView[], rng: Rng): number;
  /** The rest-stop action: a fusion that is available, or leaving. */
  rest(fusions: readonly FusionDef[], rng: Rng): RunAction;
}

/** Any legal choice with equal chance, as the Random bot plays the rest of the game. */
export const randomPolicy: RunPolicy = {
  reward: (offers, rng) => rng.int(offers.length),
  rest(fusions, rng) {
    const actions: RunAction[] = [...fusions.map((fusion): RunAction => ({ type: "fuse", recipeId: fusion.id })), { type: "leaveRest" }];
    return actions[rng.int(actions.length)] as RunAction;
  },
};

/**
 * What a sensible player does: take a new structure before an upgrade, then the upgrades in this order, and fuse
 * whenever a fusion is available. The order is a bot's taste and not a game rule; a different order is a different bot.
 */
const TASTE = [
  "structure:countMinSketch",
  "structure:logLog",
  "upgrade:power",
  "upgrade:resolve",
  "upgrade:recovery",
  "upgrade:capacity",
  "upgrade:slots",
];

export const sensiblePolicy: RunPolicy = {
  reward(offers) {
    for (const wanted of TASTE) {
      const index = offers.findIndex((offer) => offer.id === wanted);
      if (index >= 0) return index;
    }
    return 0;
  },
  rest: (fusions) => (fusions[0] ? { type: "fuse", recipeId: fusions[0].id } : { type: "leaveRest" }),
};
