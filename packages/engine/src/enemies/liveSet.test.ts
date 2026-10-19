import { describe, expect, it } from "vitest";
import { LiveSet } from "./liveSet";
import { rngFor } from "./testUtils";

const build = (values: number[]) => {
  const live = new LiveSet();
  for (const v of values) live.insert(v);
  return live;
};

describe("LiveSet", () => {
  it("tracks counts, totals and distinct values; reports the heaviest value, breaking ties toward the lowest value; turns a fully deleted value into a ghost, and a reinsert removes the ghost; and 4 more", () => {
    // tracks counts, totals and distinct values
    {
      const live = build([5, 5, 9, 5, 2]);
      expect(live.count(5)).toBe(3);
      expect(live.count(7)).toBe(0);
      expect(live.liveTotal).toBe(5);
      expect(live.distinct).toBe(3);
      expect(live.liveValues()).toEqual([2, 5, 9]);
    }
    // reports the heaviest value, breaking ties toward the lowest value
    {
      expect(build([5, 5, 9, 9, 2]).mode()).toEqual({ value: 5, count: 2 });
      expect(build([9, 9, 9, 2]).mode()).toEqual({ value: 9, count: 3 });
      expect(new LiveSet().mode()).toBeNull();
    }
    // turns a fully deleted value into a ghost, and a reinsert removes the ghost
    {
      const live = build([4, 4, 8]);
      const rng = rngFor("ghost");
      while (live.liveTotal > 0) live.deleteRandom(rng);
      expect(live.ghosts().sort()).toEqual([4, 8]);
      expect(live.distinct).toBe(0);
      live.insert(4);
      expect(live.ghosts()).toEqual([8]);
      expect(live.count(4)).toBe(1);
    }
    // only deletes values that are live, and returns null when empty
    {
      const live = build([1, 1, 2]);
      const rng = rngFor("delete");
      const removed = [live.deleteRandom(rng), live.deleteRandom(rng), live.deleteRandom(rng)].sort();
      expect(removed).toEqual([1, 1, 2]);
      expect(live.deleteRandom(rng)).toBeNull();
      expect(live.liveTotal).toBe(0);
    }
    // deletes in proportion to how many units of each value are live
    {
      const rng = rngFor("proportional");
      let heavy = 0;
      const trials = 20000;
      for (let i = 0; i < trials; i++) {
        const live = build([1, 1, 1, 2]); // value 1 holds 3 of the 4 live units
        if (live.deleteRandom(rng) === 1) heavy++;
      }
      const sigma = Math.sqrt(trials * 0.75 * 0.25);
      expect(Math.abs(heavy - trials * 0.75)).toBeLessThan(4 * sigma);
    }
    // round-trips through JSON and continues identically
    {
      const live = build([3, 3, 7, 7, 7, 1]);
      const rng = rngFor("lifecycle");
      live.deleteRandom(rng);
      const restored = LiveSet.fromSnapshot(JSON.parse(JSON.stringify(live.snapshot())));
      expect(restored.snapshot()).toStrictEqual(live.snapshot());

      const a = rngFor("continue");
      const b = rngFor("continue");
      for (let i = 0; i < 4; i++) expect(restored.deleteRandom(a)).toBe(live.deleteRandom(b));
      expect(restored.snapshot()).toStrictEqual(live.snapshot());
    }
    // snapshots are copies, and malformed snapshots are rejected
    {
      const live = build([1, 2]);
      const snap = live.snapshot();
      const frozen = JSON.stringify(snap);
      live.insert(3);
      expect(JSON.stringify(snap)).toBe(frozen);
      expect(() => LiveSet.fromSnapshot({ items: [1.5], ghosts: [] })).toThrow(RangeError);
      expect(() => LiveSet.fromSnapshot({ items: [1], ghosts: [1] })).toThrow(RangeError); // live and a ghost
      expect(() => LiveSet.fromSnapshot({ items: [-1], ghosts: [] })).toThrow(RangeError);
    }
  });
});

describe("LiveSet rank", () => {
  it("gives the share of live units at or below a value, counting every unit of a repeated value; finds the smallest live value that reaches a quantile; follows deletes; and has nothing to say with nothing live", () => {
    const live = build([10, 10, 10, 20, 30, 30, 40, 50, 50, 60]); // ten units
    expect(live.rankOf(9)).toBe(0);
    expect(live.rankOf(10)).toBe(0.3); // all three units of 10 are at or below it
    expect(live.rankOf(25)).toBe(0.4);
    expect(live.rankOf(60)).toBe(1);
    expect(live.rankOf(5e9)).toBe(1);
    // the smallest live value whose rank reaches the quantile
    expect(live.quantileValue(0.3)).toBe(10);
    expect(live.quantileValue(0.31)).toBe(20);
    expect(live.quantileValue(0.5)).toBe(30);
    expect(live.quantileValue(0.9)).toBe(50);
    expect(live.quantileValue(0.99)).toBe(60);
    expect(live.quantileValue(1)).toBe(60);
    expect(live.quantileValue(0.0001)).toBe(10);
    // a value's rank is a measure of position, so it equals the rank of its quantile or more
    for (const q of [0.1, 0.25, 0.5, 0.75, 0.95]) expect(live.rankOf(live.quantileValue(q) as number)).toBeGreaterThanOrEqual(q);
    // deletes move it
    const rng = rngFor("rank-delete");
    const before = live.rankOf(30);
    while (live.count(10) > 0) {
      const removed = live.deleteRandom(rng) as number;
      if (removed !== 10) live.insert(removed); // only the 10s are meant to go: put any other unit back
    }
    expect(live.rankOf(30)).not.toBe(before);
    // nothing live
    expect(new LiveSet().rankOf(1)).toBe(0);
    expect(new LiveSet().quantileValue(0.5)).toBeNull();
  });
});

describe("LiveSet union", () => {
  it("holds every unit of both sets, counts a value both hold once as distinct, and keeps as ghosts only the values that are live in neither; changes neither set", () => {
    const a = new LiveSet();
    const b = new LiveSet();
    for (const v of [1, 1, 2, 3]) a.insert(v);
    for (const v of [3, 4, 4]) b.insert(v);
    const rng = rngFor("union");
    // a ghost in each: 5 is deleted from a, 6 from b; and 3 is a ghost in a once it is deleted there, though b holds it
    a.insert(5);
    b.insert(6);
    while (a.count(5) > 0) { const removed = a.deleteRandom(rng) as number; if (removed !== 5) a.insert(removed); }
    while (b.count(6) > 0) { const removed = b.deleteRandom(rng) as number; if (removed !== 6) b.insert(removed); }
    a.insert(7);
    while (a.count(7) > 0) { const removed = a.deleteRandom(rng) as number; if (removed !== 7) a.insert(removed); }
    b.insert(7); // 7 is a ghost in a but live in b
    const union = LiveSet.union(a, b);
    expect(union.liveTotal).toBe(8);
    expect(union.count(1)).toBe(2);
    expect(union.count(3)).toBe(2); // one unit in each
    expect(union.count(4)).toBe(2);
    expect(union.count(7)).toBe(1);
    expect(union.distinct).toBe(5); // 1, 2, 3, 4, 7
    expect(union.ghosts().sort((x, y) => x - y)).toEqual([5, 6]); // not 7: b holds it
    expect(a.liveTotal).toBe(4);
    expect(b.liveTotal).toBe(4);
  });
});
