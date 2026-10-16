import type { RunFightRecord, RunRecord } from "./runRunner";

const fight = (tier: string, outcome: RunFightRecord["outcome"] = "won", turns = 3): RunFightRecord => ({ tier, outcome, turns });
const minions = (n: number) => Array.from({ length: n }, () => fight("minion"));

const run = (overrides: Partial<RunRecord>): RunRecord => ({
  bot: "greedy",
  seed: "x",
  outcome: "won",
  encounterReached: 6,
  fightsWon: 7,
  fights: [...minions(5), fight("elite"), fight("boss")],
  turns: 21,
  certaintyLeft: 40,
  rewards: [],
  fused: [],
  owned: [],
  upgrades: {},
  opener: "bloomFilter",
  deployed: ["bloomFilter"],
  strikes: { total: 20, wrong: 5 },
  ...overrides,
});

/** Four hand-made runs whose combined numbers are easy to check by hand: two won, one lost early, one lost to the Elite. */
export const RUNS: RunRecord[] = [
  run({ seed: "A", deployed: ["bloomFilter", "countMinSketch", "hyperLogLog"], fused: ["hyperLogLog"], certaintyLeft: 40 }),
  run({
    seed: "B",
    outcome: "lost",
    encounterReached: 2,
    fightsWon: 2,
    fights: [fight("minion"), fight("minion"), fight("minion", "lost")],
    turns: 9,
    certaintyLeft: 0,
    opener: "exactMemory",
    deployed: ["exactMemory", "bloomFilter"],
    strikes: { total: 10, wrong: 5 },
  }),
  run({
    seed: "C",
    outcome: "lost",
    encounterReached: 5,
    fightsWon: 5,
    fights: [...minions(5), fight("elite", "lost")],
    turns: 18,
    certaintyLeft: 0,
    fused: ["hyperLogLog"], // it fused and then lost the Elite, so fusing shows in the lost runs too
    deployed: ["bloomFilter", "linearCounting"],
    strikes: { total: 30, wrong: 10 },
  }),
  run({ seed: "D", deployed: ["bloomFilter", "logLog", "reservoirSampling"], certaintyLeft: 20 }),
];

export const RUN_META = { bot: "greedy", seedBase: 1 } as const;
