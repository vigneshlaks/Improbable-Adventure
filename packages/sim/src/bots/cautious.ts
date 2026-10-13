import type { Action } from "@pda/engine";
import {
  bestNumericAnswer,
  blindStrike,
  desiredKinds,
  flaggedAtLeast,
  nextDeployAction,
  targetWeakPoints,
  whole,
} from "./common";
import type { Bot, BotView } from "./types";

function strikeSafely(view: BotView): Action {
  const { observation } = view;
  if (observation.challenge?.kind === "presence") {
    // Only targets that two structures agree on.
    return { type: "strikeSubset", targets: flaggedAtLeast(observation, 2) };
  }
  const answer = bestNumericAnswer(observation);
  if (!answer) return blindStrike(observation);
  // The upper bound cannot be blocked. A Count estimate has no safe side, so it uses the estimate.
  const bound = observation.challenge?.kind === "frequency" && Number.isFinite(answer.high) ? answer.high : answer.estimate;
  return { type: "strikeValue", value: whole(bound, bound === answer.estimate ? "round" : "ceil") };
}

export const cautious: Bot = {
  name: "cautious",
  description: "Deploys two structures per weak point so answers can be cross-checked, strikes only confirmed Presence targets, and strikes Frequency at the upper bound. Tests whether safe play is viable.",
  usesTruth: false,
  create: () => (view) => {
    if (view.observation.phase === "deploy") {
      return nextDeployAction(view, desiredKinds(view, targetWeakPoints(view.observation), 2));
    }
    return strikeSafely(view);
  },
};
