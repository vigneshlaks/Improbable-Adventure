import { describe, expect, it } from "vitest";
import { LiveSet } from "../enemies/liveSet";
import { Rng } from "../rng/rng";
import type { Challenge } from "../structures/types";
import { gradeStrike, issueChallenge, trueAnswer, type ChallengeContext } from "./challenges";
import type { DamageRules } from "./damage";

const RULES: DamageRules = { base: 20, hitDamage: 5, decoyPenalty: 4, blockPenalty: 3, missPenalty: 3, overshootExp: 2, countTol: 0.25 };

// Outside values are far from the live values used below, so they can never be mistaken for real ones.
const CTX: ChallengeContext = { presenceTargets: 12, drawOutsideValue: (rng) => 1_000_000 + rng.int(5000) };

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
