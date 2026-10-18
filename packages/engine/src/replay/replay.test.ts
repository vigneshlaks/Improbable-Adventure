import { describe, expect, it } from "vitest";
import { IllegalActionError } from "../combat/types";
import { groundTruth } from "../combat/view";
import { runConfig, weakEnemy } from "../run/testUtils";
import type { RunAction, RunConfig } from "../run/types";
import { eachCase } from "../testCases";
import { ENGINE_VERSION, RunRecorder, compareSpeedruns, rankSpeedruns, verifyReplay, type Replay } from "./replay";

/** Plays a run to its end with perfect Frequency strikes, choosing the first reward and leaving every rest stop. */
function playOut(recorder: RunRecorder): void {
  for (let guard = 0; guard < 200 && recorder.state.phase !== "won" && recorder.state.phase !== "lost"; guard++) {
    const { state } = recorder;
    if (state.phase === "reward") recorder.step({ type: "chooseReward", index: 0 });
    else if (state.phase === "rest") recorder.step({ type: "leaveRest" });
    else if (state.fight?.phase === "strike") recorder.step({ type: "strikeValue", value: (groundTruth(state.fight).frequency?.count ?? 1) });
    else recorder.step({ type: "endDeploy" });
  }
}

const recordRun = (seed = "rep", config: RunConfig = runConfig()): Replay => {
  const recorder = new RunRecorder(seed, config, "hash-1");
  playOut(recorder);
  return recorder.toReplay();
};
const viaJson = (replay: Replay): Replay => JSON.parse(JSON.stringify(replay)) as Replay;

describe("recording and verifying", () => {
  it("records a run, survives JSON, and verifies to the result it claims, won or lost", () => {
    const won = recordRun();
    expect(won.engineVersion).toBe(ENGINE_VERSION);
    expect(won.claimed).toMatchObject({ won: true });
    expect(won.claimed.turns).toBeGreaterThan(0);
    expect(won.actions.length).toBeGreaterThan(10);
    expect(verifyReplay(viaJson(won))).toEqual({ ok: true, result: won.claimed });
    // The same replay is the same bytes however many times it is made.
    expect(JSON.stringify(recordRun())).toBe(JSON.stringify(won));

    // A lost run is a replay too, and claims to have lost.
    const deadly = runConfig({ encounters: [weakEnemy("minion", { attack: 500 }), ...runConfig().encounters.slice(1)] });
    const lost = recordRun("doom", deadly);
    expect(lost.claimed).toMatchObject({ won: false, certaintyLeft: 0 });
    expect(verifyReplay(viaJson(lost))).toEqual({ ok: true, result: lost.claimed });

    // The recorder will not record an action the run refuses, and will not make a replay of a run that has not finished.
    const recorder = new RunRecorder("rep", runConfig(), "hash-1");
    expect(() => recorder.step({ type: "chooseReward", index: 0 })).toThrow(IllegalActionError);
    expect(recorder.actions).toEqual([]);
    expect(() => recorder.toReplay()).toThrow(/finished/);
  });

  it("rejects a replay that has been tampered with, and says why", () => {
    const original = recordRun();
    const firstStrike = original.actions.findIndex((action) => action.type === "strikeValue");
    const edit = (change: (replay: Replay) => void): Replay => {
      const copy = viaJson(original);
      change(copy);
      return copy;
    };
    const cases: Array<[string, Replay, string | string[]]> = [
      ["an action the run refuses", edit((r) => void (r.actions[firstStrike] = { type: "chooseReward", index: 0 } as RunAction)), "illegal"],
      ["an action removed", edit((r) => void r.actions.splice(firstStrike, 1)), "illegal"],
      ["an action added after the end", edit((r) => void r.actions.push({ type: "endDeploy" })), "illegal"],
      ["the run cut short", edit((r) => void r.actions.splice(r.actions.length - 3)), "incomplete"],
      ["a win claimed as a loss", edit((r) => void (r.claimed.won = false)), "mismatch"],
      ["a turn shaved off", edit((r) => void (r.claimed.turns -= 1)), "mismatch"],
      ["more Certainty claimed", edit((r) => void (r.claimed.certaintyLeft += 1)), "mismatch"],
      ["a different seed", edit((r) => void (r.seed = "another")), ["mismatch", "illegal", "incomplete"]],
      ["a harder final enemy in the config", edit((r) => void (r.config.encounters[r.config.encounters.length - 1] = weakEnemy("boss", { attack: 4 }))), "mismatch"], // earlier damage is healed at the rest stop
      ["another engine version", edit((r) => void (r.engineVersion = "0")), "version"],
      ["missing parts", { seed: "x" } as unknown as Replay, "malformed"],
      ["actions that are not a list", edit((r) => void ((r as unknown as { actions: unknown }).actions = "no")), "malformed"],
    ];
    eachCase(cases.map(([name, replay, reason]) => [name, { replay, reason }] as const), ({ replay, reason }) => {
      const result = verifyReplay(replay);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBeOneOf(Array.isArray(reason) ? reason : [reason]);
    });
    expect(verifyReplay(null)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyReplay(original)).toMatchObject({ ok: true });
    // Content: the engine cannot hash content itself, so a caller who knows the right hash can demand it.
    expect(verifyReplay(original, { contentHash: "hash-1" })).toMatchObject({ ok: true });
    expect(verifyReplay(original, { contentHash: "hash-2" })).toMatchObject({ ok: false, reason: "content" });
    // A rejected action names where it was.
    const illegal = verifyReplay(cases[0]![1]);
    expect(illegal.ok === false && illegal.step).toBe(firstStrike);
  });
});

describe("the speedrun metric", () => {
  const run = (turns: number, certaintyLeft: number, won = true) => ({ claimed: { won, turns, certaintyLeft } });

  it("ranks fewer turns first, breaks ties by Certainty left, and leaves out runs that were lost", () => {
    expect(compareSpeedruns(run(20, 50).claimed, run(21, 90).claimed)).toBeLessThan(0);
    expect(compareSpeedruns(run(20, 90).claimed, run(20, 50).claimed)).toBeLessThan(0);
    expect(compareSpeedruns(run(20, 50).claimed, run(20, 50).claimed)).toBe(0);
    const entries = [{ id: "a", ...run(22, 10) }, { id: "b", ...run(20, 40) }, { id: "c", ...run(15, 5, false) }, { id: "d", ...run(20, 60) }, { id: "e", ...run(20, 40) }];
    expect(rankSpeedruns(entries).map((entry) => entry.id)).toEqual(["d", "b", "e", "a"]); // c lost; b before e, the order they came in
  });
});
