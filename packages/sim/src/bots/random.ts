import { randomPolicy } from "../runPolicy";
import type { Bot } from "./types";

export const random: Bot = {
  name: "random",
  description: "Takes any action the engine lists with equal chance. The floor: it should lose, and it shakes out crashes.",
  usesTruth: false,
  runPolicy: randomPolicy,
  create: () => (view, rng) => {
    const actions = view.legalActions();
    return actions[rng.int(actions.length)] ?? { type: "endDeploy" };
  },
};
