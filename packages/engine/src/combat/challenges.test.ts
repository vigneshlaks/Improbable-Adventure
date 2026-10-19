import { describe, expect, it } from "vitest";
import { LiveSet } from "../enemies/liveSet";
import { Rng } from "../rng/rng";
import type { Challenge } from "../structures/types";
import { gradeStrike, issueChallenge, jaccardToLive, trueAnswer, type ChallengeContext } from "./challenges";
import type { DamageRules } from "./damage";

const RULES: DamageRules = { base: 20, hitDamage: 5, decoyPenalty: 4, blockPenalty: 3, missPenalty: 3, overshootExp: 2, countTol: 0.25, rankTol: 0.1 };

// Outside values are far from the live values used below, so they can never be mistaken for real ones.
const CTX: ChallengeContext = { presenceTargets: 12, rankQuantile: 0.5,
  likeness: { copies: 6, threshold: 0.6, minSet: 12, maxSet: 1000, realMin: 0.66, realMax: 0.95, decoyMin: 0.35, decoyMax: 0.5 },
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

describe("issueChallenge: Presence with a Cunning enemy's decoys", () => {
  const live = liveWith(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, 2])));
  const crafted = Array.from({ length: 12 }, (_, i) => 5_000_000 + i);
  const used = (share: number, seed: string) => {
    const challenge = issueChallenge("presence", live, Rng.fromSeed(seed), { ...CTX, cunning: { decoyShare: share, decoys: crafted } });
    if (challenge?.kind !== "presence") throw new Error("expected a presence challenge");
    const decoys = challenge.targets.filter((t) => live.count(t) === 0);
    return { crafted: decoys.filter((t) => crafted.includes(t)).length, decoys: decoys.length };
  };

  it("uses crafted values for the share of decoys it is given: none at 0, all at 1, about half at a half, never twice", () => {
    let half = 0;
    let halfDecoys = 0;
    for (let i = 0; i < 60; i++) {
      expect(used(0, `none-${i}`).crafted).toBe(0);
      const all = used(1, `all-${i}`);
      expect(all.crafted).toBe(all.decoys);
      const mid = used(0.5, `half-${i}`);
      half += mid.crafted;
      halfDecoys += mid.decoys;
    }
    expect(half / halfDecoys).toBeGreaterThan(0.4);
    expect(half / halfDecoys).toBeLessThan(0.6);
    expect(issueChallenge("presence", live, Rng.fromSeed("a"), { ...CTX, cunning: { decoyShare: 1, decoys: [] } })).toMatchObject({ kind: "presence" }); // nothing crafted: ordinary decoys
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

describe("Likeness", () => {
  const live = liveWith(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i + 1, (i % 3) + 1])), [900, 901, 902, 903, 904, 905, 906, 907]);
  const ctx = (decoyMin: number, decoyMax: number): ChallengeContext => ({ ...CTX, likeness: { ...CTX.likeness, decoyMin, decoyMax } });
  const issue = (set: LiveSet, seed: string, context: ChallengeContext = CTX) => {
    const challenge = issueChallenge("likeness", set, Rng.fromSeed(seed), context);
    if (challenge === null) return null;
    if (challenge.kind !== "likeness") throw new Error("expected a likeness challenge");
    return challenge;
  };

  it("shows the configured number of copies named by position; makes about half of them real, with the similarity of each in its band (real copies from the real band, decoys from the trait's band); builds copies from live values plus values that are not live; is deterministic; cannot be asked of too small or too large a set; and measures similarity as shared values over values in either", () => {
    // K copies, named 0..K-1, carrying the threshold; the real ones about half; each copy's similarity inside its band (a little slack for rounding)
    const realCounts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const challenge = issue(live, `like-${i}`) as NonNullable<ReturnType<typeof issue>>;
      expect(challenge.targets).toEqual([0, 1, 2, 3, 4, 5]);
      expect(challenge.copies).toHaveLength(6);
      expect(challenge.threshold).toBe(0.6);
      const answer = trueAnswer(challenge, live);
      if (answer.kind !== "likeness") throw new Error("expected a likeness answer");
      const real = answer.real.filter(Boolean).length;
      expect(real).toBeGreaterThanOrEqual(2);
      expect(real).toBeLessThanOrEqual(4);
      realCounts.add(real);
      answer.similarity.forEach((s, c) => {
        if (answer.real[c]) expect(s).toBeGreaterThan(0.6);
        else expect(s).toBeLessThanOrEqual(0.55);
        expect(s).toBeGreaterThan(0.3);
        expect(s).toBeLessThan(0.97);
      });
      // a copy is distinct values, some live and the rest not live
      for (const copy of challenge.copies) {
        expect(new Set(copy).size).toBe(copy.length);
        expect(copy.filter((v) => live.count(v) > 0).length).toBeGreaterThan(0);
      }
    }
    expect(realCounts.size).toBeGreaterThan(1); // the split varies
    // real copies are spread over the whole real band (mean of 0.66 and 0.95 is 0.805), and are not always first
    {
      let sum = 0;
      let count = 0;
      let top = 0;
      const firstReal = new Set<boolean>();
      for (let i = 0; i < 60; i++) {
        const challenge = issue(live, `spread-${i}`) as NonNullable<ReturnType<typeof issue>>;
        const answer = trueAnswer(challenge, live);
        if (answer.kind !== "likeness") throw new Error("expected a likeness answer");
        firstReal.add(answer.real[0] as boolean);
        answer.similarity.forEach((s, c) => { if (answer.real[c]) { sum += s; count++; if (s > 0.9) top++; } });
      }
      expect(Math.abs(sum / count - 0.805)).toBeLessThan(0.02);
      expect(top / count).toBeGreaterThan(0.1); // the top of the band is reached: a high similarity needs few added values
      expect(firstReal.size).toBe(2);
    }
    // the trait sets how close the decoys sit: Low is far below the threshold, High is just under it
    for (const [min, max] of [[0.05, 0.3], [0.5, 0.58]] as const) {
      for (let i = 0; i < 20; i++) {
        const challenge = issue(live, `band-${i}`, ctx(min, max)) as NonNullable<ReturnType<typeof issue>>;
        const answer = trueAnswer(challenge, live);
        if (answer.kind !== "likeness") throw new Error("expected a likeness answer");
        for (const [c, s] of answer.similarity.entries()) if (!answer.real[c]) { expect(s).toBeGreaterThan(min - 0.04); expect(s).toBeLessThan(max + 0.04); }
      }
    }
    // the values added to a copy are ghosts or never-inserted values, and both turn up
    {
      let ghostValues = 0;
      let outsideValues = 0;
      for (let i = 0; i < 30; i++) {
        for (const copy of (issue(live, `mix-${i}`) as NonNullable<ReturnType<typeof issue>>).copies) {
          for (const v of copy) {
            if (live.count(v) > 0) continue;
            if (live.ghosts().includes(v)) ghostValues++;
            else { outsideValues++; expect(v).toBeGreaterThanOrEqual(1_000_000); }
          }
        }
      }
      expect(ghostValues).toBeGreaterThan(0);
      expect(outsideValues).toBeGreaterThan(0);
    }
    // deterministic for a given generator
    expect(issue(live, "same")).toEqual(issue(live, "same"));
    expect(issue(live, "same")).not.toEqual(issue(live, "other"));
    // too few or too many live values to ask about (the copies are as large as the set)
    expect(issue(liveWith({ 1: 5, 2: 5 }), "tiny")).toBeNull();
    expect(issue(liveWith(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, 1]))), "eleven")).toBeNull();
    expect(issue(liveWith(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1]))), "twelve")).not.toBeNull();
    expect(issue(new LiveSet(), "empty")).toBeNull();
    expect(issue(liveWith(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [i + 1, 1]))), "huge")).toBeNull();
    expect(issue(liveWith(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i + 1, 1]))), "limit")).not.toBeNull();
    // similarity is shared values over values in either (ten live values; a copy of five of them and one other: 5 / 11); repeats do not count
    const ten = liveWith(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 2])));
    const answer = trueAnswer({ kind: "likeness", targets: [0, 1, 2], copies: [[1, 2, 3, 4, 5, 99], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [50, 51]], threshold: 0.6 }, ten);
    expect(answer).toEqual({ kind: "likeness", real: [false, true, false], similarity: [5 / 11, 1, 0] });
    expect(jaccardToLive([1, 1, 2, 2], ten)).toBe(2 / 10);
    // exactly at the threshold is real: six of the ten live values, nothing else, is 6 / 10
    expect(trueAnswer({ kind: "likeness", targets: [0], copies: [[1, 2, 3, 4, 5, 6]], threshold: 0.6 }, ten)).toMatchObject({ real: [true] });
  });

  it("grades a strike as Presence does: HIT_DAMAGE per real copy, DECOY_PENALTY per decoy; refuses a strike of the wrong kind", () => {
    const challenge: Challenge = { kind: "likeness", targets: [0, 1, 2], copies: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [50, 51], [1, 2, 3, 4, 5, 6, 7, 8, 9, 99]], threshold: 0.6 };
    const ten = liveWith(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 1])));
    // copy 0 is the live set itself (1), copy 1 shares nothing, copy 2 shares nine of eleven (9 / 11)
    expect(gradeStrike(challenge, ten, { targets: [0, 2] }, RULES)).toEqual({ kind: "likeness", realHits: 2, decoyHits: 0, damage: 10, certaintyLost: 0, realTotal: 2 });
    expect(gradeStrike(challenge, ten, { targets: [0, 1] }, RULES)).toMatchObject({ kind: "likeness", realHits: 1, decoyHits: 1, damage: 5, certaintyLost: 4 });
    expect(() => gradeStrike(challenge, ten, { value: 3 }, RULES)).toThrow(RangeError);
  });
});
