import type { Action } from "@pda/engine";
import {
  bestNumericAnswer,
  blindStrike,
  desiredKinds,
  flaggedBy,
  nextDeployAction,
  targetWeakPoints,
  whole,
} from "./common";
import type { Bot, BotView } from "./types";

/** Strikes on the best structure's estimate: everything it flagged, or its estimate as a number. */
export function strikeOnEstimate(view: BotView): Action {
  const { observation } = view;
  if (observation.challenge?.kind === "presence") {
    const best = flaggedBy(observation)[0];
    return best ? { type: "strikeSubset", targets: best.positions } : blindStrike(observation);
  }
  const answer = bestNumericAnswer(observation);
  return answer ? { type: "strikeValue", value: whole(answer.estimate) } : blindStrike(observation);
}

export const greedy: Bot = {
  name: "greedy",
  description: "Deploys the best-matching structure for the two likeliest weak points and strikes on its estimate. Baseline competent play.",
  usesTruth: false,
  create: () => (view) => {
    if (view.observation.phase === "deploy") {
      return nextDeployAction(view, desiredKinds(view, targetWeakPoints(view.observation), 1));
    }
    return strikeOnEstimate(view);
  },
};
