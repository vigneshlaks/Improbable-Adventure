import type { FightRecord } from "./runner";

/** Four hand-made fights whose combined numbers are easy to check by hand. */
const fight = (overrides: Partial<FightRecord>): FightRecord => ({
  bot: "greedy",
  seed: "x",
  tier: "minion",
  outcome: "won",
  reason: null,
  turns: 4,
  certaintyLeft: 80,
  steps: 10,
  certaintyLost: { blocked: 0, decoys: 0, misses: 0, attacks: 0, turnLimit: 0 },
  strikes: { total: 0, wrong: 0 },
  deployed: [],
  accuracy: {},
  ...overrides,
});

export const RECORDS: FightRecord[] = [
  fight({
    seed: "A",
    turns: 4,
    certaintyLeft: 80,
    certaintyLost: { blocked: 0, decoys: 0, misses: 0, attacks: 12, turnLimit: 0 },
    strikes: { total: 3, wrong: 1 },
    deployed: ["countMinSketch", "bloomFilter"],
    accuracy: { countMinSketch: { answers: 2, covered: 2, confidenceSum: 1.96, relativeErrorSum: 0.2, relativeErrorCount: 2 } },
  }),
  fight({
    seed: "B",
    outcome: "lost",
    reason: "turnLimit",
    turns: 8,
    certaintyLeft: 30,
    certaintyLost: { blocked: 21, decoys: 0, misses: 0, attacks: 24, turnLimit: 20 },
    strikes: { total: 7, wrong: 7 },
    deployed: ["bloomFilter"],
    accuracy: { bloomFilter: { answers: 3, covered: 2, confidenceSum: 2.85, relativeErrorSum: 0, relativeErrorCount: 0 } },
  }),
  fight({
    seed: "C",
    turns: 4,
    certaintyLeft: 90,
    certaintyLost: { blocked: 0, decoys: 0, misses: 0, attacks: 6, turnLimit: 0 },
    strikes: { total: 2, wrong: 0 },
    deployed: ["countMinSketch"],
    accuracy: { countMinSketch: { answers: 1, covered: 0, confidenceSum: 0.98, relativeErrorSum: 0.4, relativeErrorCount: 1 } },
  }),
  fight({
    seed: "D",
    outcome: "lost",
    reason: "certainty",
    turns: 6,
    certaintyLeft: 0,
    certaintyLost: { blocked: 6, decoys: 8, misses: 3, attacks: 18, turnLimit: 0 },
    strikes: { total: 5, wrong: 4 },
    deployed: ["countMinSketch", "bloomFilter"],
  }),
];

export const META = { bot: "greedy", tier: "minion", loadout: "starting", seedBase: 1 } as const;
