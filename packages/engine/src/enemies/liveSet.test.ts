import { describe, expect, it } from "vitest";
import { LiveSet } from "./liveSet";
import { rngFor } from "./testUtils";

const build = (values: number[]) => {
  const live = new LiveSet();
  for (const v of values) live.insert(v);
  return live;
};

describe("LiveSet", () => {
  it("tracks counts, totals and distinct values", () => {
    const live = build([5, 5, 9, 5, 2]);
    expect(live.count(5)).toBe(3);
    expect(live.count(7)).toBe(0);
    expect(live.liveTotal).toBe(5);
    expect(live.distinct).toBe(3);
    expect(live.liveValues()).toEqual([2, 5, 9]);
  });

  it("reports the heaviest value, breaking ties toward the lowest value", () => {
    expect(build([5, 5, 9, 9, 2]).mode()).toEqual({ value: 5, count: 2 });
    expect(build([9, 9, 9, 2]).mode()).toEqual({ value: 9, count: 3 });
    expect(new LiveSet().mode()).toBeNull();
  });

  it("turns a fully deleted value into a ghost, and a reinsert removes the ghost", () => {
    const live = build([4, 4, 8]);
    const rng = rngFor("ghost");
    while (live.liveTotal > 0) live.deleteRandom(rng);
    expect(live.ghosts().sort()).toEqual([4, 8]);
    expect(live.distinct).toBe(0);
    live.insert(4);
    expect(live.ghosts()).toEqual([8]);
    expect(live.count(4)).toBe(1);
  });

  it("only deletes values that are live, and returns null when empty", () => {
    const live = build([1, 1, 2]);
    const rng = rngFor("delete");
    const removed = [live.deleteRandom(rng), live.deleteRandom(rng), live.deleteRandom(rng)].sort();
    expect(removed).toEqual([1, 1, 2]);
    expect(live.deleteRandom(rng)).toBeNull();
    expect(live.liveTotal).toBe(0);
  });

  it("deletes in proportion to how many units of each value are live", () => {
    const rng = rngFor("proportional");
    let heavy = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const live = build([1, 1, 1, 2]); // value 1 holds 3 of the 4 live units
      if (live.deleteRandom(rng) === 1) heavy++;
    }
    const sigma = Math.sqrt(trials * 0.75 * 0.25);
    expect(Math.abs(heavy - trials * 0.75)).toBeLessThan(4 * sigma);
  });

  it("round-trips through JSON and continues identically", () => {
    const live = build([3, 3, 7, 7, 7, 1]);
    const rng = rngFor("lifecycle");
    live.deleteRandom(rng);
    const restored = LiveSet.fromSnapshot(JSON.parse(JSON.stringify(live.snapshot())));
    expect(restored.snapshot()).toStrictEqual(live.snapshot());

    const a = rngFor("continue");
    const b = rngFor("continue");
    for (let i = 0; i < 4; i++) expect(restored.deleteRandom(a)).toBe(live.deleteRandom(b));
    expect(restored.snapshot()).toStrictEqual(live.snapshot());
  });

  it("snapshots are copies, and malformed snapshots are rejected", () => {
    const live = build([1, 2]);
    const snap = live.snapshot();
    const frozen = JSON.stringify(snap);
    live.insert(3);
    expect(JSON.stringify(snap)).toBe(frozen);
    expect(() => LiveSet.fromSnapshot({ items: [1.5], ghosts: [] })).toThrow(RangeError);
    expect(() => LiveSet.fromSnapshot({ items: [1], ghosts: [1] })).toThrow(RangeError); // live and a ghost
    expect(() => LiveSet.fromSnapshot({ items: [-1], ghosts: [] })).toThrow(RangeError);
  });
});
