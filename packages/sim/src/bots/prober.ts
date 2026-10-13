import { desiredKinds, nextDeployAction, targetWeakPoints, totalSlots } from "./common";
import { strikeOnEstimate } from "./greedy";
import type { Bot } from "./types";

/** The share of the first turn's Space spent on the probe. */
const PROBE_SHARE = 0.4;

export const prober: Bot = {
  name: "prober",
  description: "Opens with Reservoir Sampling, which can answer any question, then commits to the best match for the weak point. Tests whether probing beats going straight in.",
  usesTruth: false,
  create: () => (view) => {
    const { observation } = view;
    if (observation.phase !== "deploy") return strikeOnEstimate(view);

    if (observation.turn === 1 && observation.structures.length === 0 && view.loadout.includes("reservoirSampling")) {
      return { type: "deploy", slot: 0, kind: "reservoirSampling", spaceBits: Math.floor(observation.spaceFree * PROBE_SHARE) };
    }
    // Keep the probe, then fill the other slots as Greedy would.
    const wanted = ["reservoirSampling" as const, ...desiredKinds(view, targetWeakPoints(observation), 1)].filter(
      (kind, index, kinds) => view.loadout.includes(kind) && kinds.indexOf(kind) === index,
    );
    return nextDeployAction(view, wanted.slice(0, totalSlots(observation)));
  },
};
