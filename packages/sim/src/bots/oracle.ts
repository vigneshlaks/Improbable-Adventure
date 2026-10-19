import type { Action } from "@pda/engine";
import type { Bot } from "./types";

export const oracle: Bot = {
  name: "oracle",
  description: "Knows the true answers, deploys nothing, and strikes perfectly. The ceiling: it shows the fastest possible fight.",
  usesTruth: true,
  create: () => (view): Action => {
    if (view.observation.phase === "deploy") return { type: "endDeploy" };
    const answer = view.truth?.answer;
    switch (answer?.kind) {
      case "presence":
      case "likeness":
        return { type: "strikeSubset", targets: answer.real.flatMap((isReal, position) => (isReal ? [position] : [])) };
      case "frequency":
        return { type: "strikeValue", value: answer.count };
      case "count":
        return { type: "strikeValue", value: answer.distinct };
      case "rank":
        return { type: "strikeValue", value: answer.value }; // the smallest value that reaches the armor's quantile
      default:
        throw new Error("The Oracle needs the true answers, but the runner did not provide them");
    }
  },
};
