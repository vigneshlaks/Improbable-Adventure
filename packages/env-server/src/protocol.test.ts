import { describe, expect, it } from "vitest";
import { Batch, handleLine } from "./protocol";

const send = (batch: Batch, request: object) => JSON.parse(handleLine(batch, JSON.stringify(request)));

describe("the protocol", () => {
  it("describes the problem, plays a batch of games side by side, resets one game on its own, repeats exactly, and answers bad requests with an error", () => {
    const batch = new Batch();
    const info = send(batch, { cmd: "info" });
    expect(info.nActions).toBe(info.labels.length);
    expect(info.obsSize).toBeGreaterThan(50);

    const first = send(batch, { cmd: "reset", seeds: ["a1", "a2"] });
    expect(first.obs).toHaveLength(2);
    expect(first.obs[0]).toHaveLength(info.obsSize);
    expect(first.masks[0]).toHaveLength(info.nActions);
    expect(first.dones).toEqual([false, false]);
    expect(first.obs[0]).not.toEqual(first.obs[1]); // different seeds, different enemies

    // Each game takes its own first legal action; the reply has one entry per game.
    const actions = first.masks.map((mask: boolean[]) => mask.findIndex(Boolean));
    const next = send(batch, { cmd: "step", actions });
    expect(next.rewards).toHaveLength(2);
    expect(next.truncated).toEqual([false, false]);

    // Resetting game 1 alone leaves game 0 where it was.
    const before = JSON.stringify(send(batch, { cmd: "reset", seeds: ["a1", "a2"] }));
    send(batch, { cmd: "step", actions });
    const only = send(batch, { cmd: "reset", seeds: ["a2"], indices: [1] });
    expect(only.obs).toHaveLength(1);
    expect(JSON.stringify(send(batch, { cmd: "reset", seeds: ["a1", "a2"] }))).toBe(before); // the same seeds replay the same games

    // A game that has ended ignores further actions and repeats its last reply, with no reward, until it is reset.
    const cut = new Batch({ maxSteps: 2 });
    let two = JSON.parse(handleLine(cut, JSON.stringify({ cmd: "reset", seeds: ["c1", "c2"] })));
    two = JSON.parse(handleLine(cut, JSON.stringify({ cmd: "step", actions: two.masks.map((m: boolean[]) => m.findIndex(Boolean)) })));
    two = JSON.parse(handleLine(cut, JSON.stringify({ cmd: "step", actions: two.masks.map((m: boolean[]) => m.findIndex(Boolean)) })));
    expect(two.truncated).toEqual([true, true]);
    const again = send(cut, { cmd: "step", actions: [0, 0] });
    expect(again.obs).toEqual(two.obs);
    expect(again.rewards).toEqual([0, 0]);
    expect(again.truncated).toEqual([true, true]);

    // Bad requests give an error and leave the batch usable.
    for (const request of [{ cmd: "nope" }, { cmd: "reset", seeds: [1] }, { cmd: "step", actions: [0.5] }, { cmd: "step", actions: [0] }, { cmd: "reset", seeds: ["x"], indices: [9] }]) {
      expect(send(batch, request).error).toEqual(expect.any(String));
    }
    expect(handleLine(batch, "not json")).toMatch(/"error"/);
    expect(send(batch, { cmd: "reset", seeds: ["a1"] }).obs).toHaveLength(1);
  });
});
