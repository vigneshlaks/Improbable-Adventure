import { describe, expect, it } from "vitest";
import { LiveSet } from "../enemies/liveSet";
import { Rng } from "../rng/rng";
import type { Challenge } from "../structures/types";
import { gradeStrike, issueChallenge, trueAnswer, type ChallengeContext } from "./challenges";
import type { DamageRules } from "./damage";

const RULES: DamageRules = { base: 20, hitDamage: 5, decoyPenalty: 4, blockPenalty: 3, missPenalty: 3, overshootExp: 2, countTol: 0.25, rankTol: 0.1 };

// Outside values are far from the live values used below, so they can never be mistaken for real ones.
const CTX: ChallengeContext = { presenceTargets: 12, rankQuantile: 0.5,
  drawOutsideValue: (rng) => 1_000_000 + rng.int(5000) };

function liveWith(counts: Record<number, number>, ghosts: number[] = []): LiveSet {
  const live = new LiveSet();
  for (const [value, count] of Object.entries(counts)) for (let i = 0; i < count; i++) live.insert(Number(value));
  // Make each requested ghost a value that was inserted and then fully deleted.
  const rng = Rng.fromSeed("ghost-setup");
  for (const g of ghosts) {
    live.insert(g);
    while (live.count(g) > 0) {
      // Delete units until the ghost is gone; other values are restored afterwards.
      const removed = live.deleteRandom(rng) as number;
      if (removed !== g) live.insert(removed);
    }
  }
  return live;
}

const manyLive = () => liveWith(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, (i % 5) + 1])));

describe("issueChallenge: Frequency", () => {
  it("names the heaviest live value; breaks ties toward the lowest value; cannot be issued when nothing is live", () => {
    // names the heaviest live value
    {
      const live = liveWith({ 10: 3, 20: 9, 30: 5 });
      expect(issueChallenge("frequency", live, Rng.fromSeed("f"), CTX)).toEqual({ kind: "frequency", value: 20 });
    }
    // breaks ties toward the lowest value
    {
      expect(issueChallenge("frequency", liveWith({ 30: 4, 10: 4, 20: 4 }), Rng.fromSeed("f"), CTX)).toEqual({ kind: "frequency", value: 10 });
    }
    // cannot be issued when nothing is live
    {
      expect(issueChallenge("frequency", new LiveSet(), Rng.fromSeed("f"), CTX)).toBeNull();
    }
  });
});

describe("issueChallenge: Count", () => {
  it("carries no data, because the question is always the live distinct count", () => {
    expect(issueChallenge("count", manyLive(), Rng.fromSeed("c"), CTX)).toEqual({ kind: "count" });
  });
});

describe("issueChallenge: Presence", () => {
  const issue = (live: LiveSet, seed: string) => {
    const challenge = issueChallenge("presence", live, Rng.fromSeed(seed), CTX);
    if (challenge?.kind !== "presence") throw new Error("expected a presence challenge");
    return challenge.targets;
  };

  it("shows the configured number of distinct targets; makes roughly half the targets real: live values, with the rest not live; uses ghosts (deleted values) as decoys when there are any, and never-inserted values otherwise; and 4 more", () => {
    // shows the configured number of distinct targets
    {
      for (const seed of ["a", "b", "c", "d"]) {
        const targets = issue(manyLive(), seed);
        expect(targets).toHaveLength(12);
        expect(new Set(targets).size).toBe(12);
      }
    }
    // makes roughly half the targets real: live values, with the rest not live
    {
      const live = liveWith(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, 2])), [900, 901, 902, 903]);
      const realCounts = new Set<number>();
      for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const targets = issue(live, seed);
        const real = targets.filter((t) => live.count(t) > 0).length;
        expect(real).toBeGreaterThanOrEqual(5);
        expect(real).toBeLessThanOrEqual(7);
        realCounts.add(real);
      }
      expect(realCounts.size).toBeGreaterThan(1); // the split varies
    }
    // uses ghosts (deleted values) as decoys when there are any, and never-inserted values otherwise
    {
      const live = liveWith(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, 2])), [900, 901, 902, 903]);
      let ghostDecoys = 0;
      let outsideDecoys = 0;
      for (let i = 0; i < 30; i++) {
        for (const t of issue(live, `mix-${i}`)) {
          if (live.ghosts().includes(t)) ghostDecoys++;
          else if (t >= 1_000_000) outsideDecoys++;
        }
      }
      expect(ghostDecoys).toBeGreaterThan(0);
      expect(outsideDecoys).toBeGreaterThan(0);

      const noGhosts = issue(manyLive(), "plain");
      expect(noGhosts.filter((t) => t >= 1_000_000).length).toBeGreaterThan(0);
    }
    // does not reveal which targets are real by their position
    {
      const live = manyLive();
      const firstIsReal = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => live.count(issue(live, `pos-${i}`)[0] as number) > 0);
      expect(firstIsReal).toContain(true);
      expect(firstIsReal).toContain(false);
    }
    // is deterministic for a given generator
    {
      expect(issue(manyLive(), "same")).toEqual(issue(manyLive(), "same"));
      expect(issue(manyLive(), "same")).not.toEqual(issue(manyLive(), "other"));
    }
    // fills with decoys when fewer values are live than the number of real targets wanted
    {
      const targets = issue(liveWith({ 7: 5, 8: 2 }), "sparse");
      expect(targets).toHaveLength(12);
      expect(targets.filter((t) => t === 7 || t === 8)).toHaveLength(2);
    }
    // is all decoys when nothing is live
    {
      const targets = issue(new LiveSet(), "empty");
      expect(targets).toHaveLength(12);
      expect(targets.every((t) => t >= 1_000_000)).toBe(true);
    }
  });
});

describe("trueAnswer", () => {
  it("reports which presence targets are real, the true frequency count, and the distinct count", () => {
    const live = liveWith({ 10: 3, 20: 9 }, [99]);
    expect(trueAnswer({ kind: "presence", targets: [10, 99, 20, 5] }, live)).toEqual({ kind: "presence", real: [true, false, true, false] });
    expect(trueAnswer({ kind: "frequency", value: 20 }, live)).toEqual({ kind: "frequency", count: 9 });
    expect(trueAnswer({ kind: "count" }, live)).toEqual({ kind: "count", distinct: 2 });
  });
});

describe("gradeStrike", () => {
  const live = liveWith({ 10: 3, 20: 9, 30: 5 });

  it("grades a Frequency strike against the live count; grades a Count strike against the live distinct count; grades a Presence strike against which targets are live; and 1 more", () => {
    // grades a Frequency strike against the live count
    {
      const challenge = { kind: "frequency", value: 20 } as const;
      expect(gradeStrike(challenge, live, { value: 8 }, RULES)).toMatchObject({ outcome: "blocked", certaintyLost: 3 });
      expect(gradeStrike(challenge, live, { value: 9 }, RULES)).toMatchObject({ outcome: "hit", damage: 20 });
      expect(gradeStrike(challenge, live, { value: 18 }, RULES)).toMatchObject({ outcome: "hit", damage: 5 });
    }
    // grades a Count strike against the live distinct count
    {
      expect(gradeStrike({ kind: "count" }, live, { value: 3 }, RULES)).toMatchObject({ outcome: "hit", damage: 20 });
      expect(gradeStrike({ kind: "count" }, live, { value: 30 }, RULES)).toMatchObject({ outcome: "miss" });
    }
    // grades a Presence strike against which targets are live
    {
      const challenge: Challenge = { kind: "presence", targets: [10, 777, 20, 888] };
      expect(gradeStrike(challenge, live, { targets: [0, 2] }, RULES)).toMatchObject({ realHits: 2, decoyHits: 0, damage: 10 });
      expect(gradeStrike(challenge, live, { targets: [1, 3] }, RULES)).toMatchObject({ realHits: 0, decoyHits: 2, certaintyLost: 8 });
    }
    // rejects a strike of the wrong kind for the challenge
    {
      expect(() => gradeStrike({ kind: "frequency", value: 20 }, live, { targets: [0] }, RULES)).toThrow(RangeError);
      expect(() => gradeStrike({ kind: "count" }, live, { targets: [0] }, RULES)).toThrow(RangeError);
      expect(() => gradeStrike({ kind: "presence", targets: [10] }, live, { value: 5 }, RULES)).toThrow(RangeError);
    }
  });
});

describe("Rank", () => {
  const ctx = (rankQuantile: number): ChallengeContext => ({ ...CTX, rankQuantile });
  const issue = (live: LiveSet, q: number) => issueChallenge("rank", live, Rng.fromSeed("rank"), ctx(q));

  it("sets the armor at the rank of the smallest live value that reaches the enemy's quantile, so that value is a perfect strike; cannot be issued with nothing live; answers with that value; and grades a strike by the rank of the value struck", () => {
    // ten units: 10 x5, then 20 x3, 30 x2. The 0.5 quantile is 10 (rank 0.5); the 0.6 quantile is 20, and the armor is set at 20's rank, 0.8
    const live = liveWith({ 10: 5, 20: 3, 30: 2 });
    expect(issue(live, 0.5)).toEqual({ kind: "rank", quantile: 0.5 });
    expect(issue(live, 0.6)).toEqual({ kind: "rank", quantile: 0.8 }); // snapped up to what a value can reach
    expect(issue(live, 0.99)).toEqual({ kind: "rank", quantile: 1 });
    expect(issue(new LiveSet(), 0.5)).toBeNull();

    const armor = issue(live, 0.6) as Extract<ReturnType<typeof issue>, { kind: "rank" }>;
    expect(trueAnswer(armor, live)).toEqual({ kind: "rank", quantile: 0.8, value: 20 });

    // Striking the answer is a perfect hit; any lower value is blocked; a higher one loses damage by how far its rank is above (RANK_TOL 0.1 here)
    expect(gradeStrike(armor, live, { value: 20 }, RULES)).toMatchObject({ kind: "rank", outcome: "hit", damage: 20, rank: 0.8, force: 20 });
    expect(gradeStrike(armor, live, { value: 19 }, RULES)).toMatchObject({ outcome: "blocked", certaintyLost: 3, rank: 0.5 });
    expect(gradeStrike(armor, live, { value: 10 }, RULES)).toMatchObject({ outcome: "blocked" });
    expect(gradeStrike(armor, live, { value: 30 }, RULES)).toMatchObject({ outcome: "hit", damage: 0, rank: 1 }); // 0.2 above: past the tolerance
    // a strike of the wrong kind is refused
    expect(() => gradeStrike(armor, live, { targets: [0] }, RULES)).toThrow(RangeError);
  });

  it("never leaves the enemy with an armor no value can match, on any stream: the best value always deals full damage", () => {
    // Heavy values span more of the ranks than the tolerance, which is what the snapping is for.
    for (const counts of [{ 5: 1, 9: 1, 12: 1, 400: 97 }, { 1: 50, 2: 50 }, { 7: 1 }, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i * 3 + 1, i % 4 === 0 ? 20 : 1]))]) {
      const live = liveWith(counts);
      for (const q of [0.01, 0.5, 0.75, 0.9, 0.99]) {
        const armor = issue(live, q);
        if (armor?.kind !== "rank") throw new Error("expected a rank challenge");
        const best = trueAnswer(armor, live);
        if (best.kind !== "rank") throw new Error("expected a rank answer");
        expect(armor.quantile).toBeGreaterThanOrEqual(q);
        expect(gradeStrike(armor, live, { value: best.value }, RULES)).toMatchObject({ outcome: "hit", damage: 20 });
      }
    }
  });
});
