import type { Rng, RewardView, RunAction } from "@pda/engine";

/** How a bot decides what the fight-level bots do not cover: which reward to take, and what to do at a rest stop. */
export interface RunPolicy {
  /** The index of the reward to take among those on offer. */
  reward(offers: readonly RewardView[], rng: Rng): number;
  /** One of the legal rest-stop actions (fusing, attaching an enchantment, or leaving). The runner asks again until it leaves. */
  rest(actions: readonly RunAction[], rng: Rng): RunAction;
}

/** Any legal choice with equal chance, as the Random bot plays the rest of the game. */
export const randomPolicy: RunPolicy = {
  reward: (offers, rng) => rng.int(offers.length),
  rest: (actions, rng) => actions[rng.int(actions.length)] ?? { type: "leaveRest" },
};

/**
 * What a sensible player does: take a new structure before an enchantment, an enchantment before an upgrade, then the
 * upgrades in this order; at the rest stop make Count-Min steady, fuse when possible, and put Steady on a LogLog only if it
 * is not about to be fused away. That order is a bot's taste, not a game rule; a different order is a different bot.
 */
const TASTE = [
  "structure:countMinSketch",
  "structure:logLog",
  "enchantment:steady",
  "upgrade:power",
  "upgrade:resolve",
  "upgrade:recovery",
  "upgrade:capacity",
  "upgrade:slots",
];

const is = (action: RunAction, type: RunAction["type"]) => action.type === type;

export const sensiblePolicy: RunPolicy = {
  reward(offers) {
    for (const wanted of TASTE) {
      const index = offers.findIndex((offer) => offer.id === wanted);
      if (index >= 0) return index;
    }
    return 0;
  },
  rest(actions) {
    const steadyCountMin = actions.find((a) => a.type === "enchant" && a.enchantmentId === "steady" && a.kind === "countMinSketch");
    if (steadyCountMin) return steadyCountMin;
    const fuse = actions.find((a) => is(a, "fuse"));
    if (fuse) return fuse;
    const steadyLogLog = actions.find((a) => a.type === "enchant" && a.enchantmentId === "steady" && a.kind === "logLog");
    return steadyLogLog ?? { type: "leaveRest" };
  },
};
