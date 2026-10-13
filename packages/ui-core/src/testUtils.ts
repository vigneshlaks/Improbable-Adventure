import type { Answer, Observation, StructureKind, StructureView } from "@pda/engine";

/** A plain observation at the start of a fight, with any field overridden. */
export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    turn: 1,
    phase: "deploy",
    certainty: 100,
    enemyHp: 40,
    spaceFree: 8192,
    slotsFree: 3,
    traits: { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low" },
    weakPoint: null,
    challenge: null,
    structures: [],
    ...overrides,
  };
}

export const answer = (estimate: number | number[], low: number, high: number, confidence = 0.95): Answer => ({
  estimate,
  low,
  high,
  confidence,
});

/** A deployed structure as the player sees it. `slot` is the engine's 0-based slot. */
export function view(slot: number, kind: StructureKind, theAnswer: Answer | null = null, spaceBits = 1024): StructureView {
  return { slot, kind, params: {}, spaceBits, answer: theAnswer };
}
