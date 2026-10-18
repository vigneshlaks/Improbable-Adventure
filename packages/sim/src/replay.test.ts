import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash } from "@pda/content";
import { verifyReplay, type Replay } from "@pda/engine";
import { getBot } from "./bots";
import { main } from "./cli";
import { recordReplay } from "./replayRecorder";
import { playRun } from "./runRunner";
import { buildRunConfig } from "@pda/content";

const REPLAYS = new URL("../../../replays/", import.meta.url);
const files = new Map<string, string>();
const io = { readText: (path: string) => files.get(path) ?? (() => { throw new Error(`No such file: ${path}`); })() };
const run = (...argv: string[]) => main(argv, io);

describe("recording a bot's run as a replay", () => {
  it("makes a replay that verifies and says what the run did, the same every time, for a won run and a lost one", () => {
    const won = recordReplay({ bot: getBot("oracle"), seed: "7" });
    const record = playRun({ config: buildRunConfig({ seed: "7" }), seed: "7", bot: getBot("oracle") });
    expect(won.claimed).toEqual({ won: true, turns: record.turns, certaintyLeft: record.certaintyLeft });
    expect(won.contentHash).toBe(contentHash());
    expect(verifyReplay(JSON.parse(JSON.stringify(won)))).toEqual({ ok: true, result: won.claimed });
    expect(JSON.stringify(recordReplay({ bot: getBot("oracle"), seed: "7" }))).toBe(JSON.stringify(won));

    const lost = recordReplay({ bot: getBot("random"), seed: "7" });
    expect(lost.claimed.won).toBe(false);
    expect(verifyReplay(lost)).toMatchObject({ ok: true });
    expect(() => recordReplay({ bot: getBot("greedy"), seed: "7", maxSteps: 5 })).toThrow(/finish/i); // a run that never ends has no result to claim
  });
});

describe("sim replay", () => {
  it("records to a file, verifies it, rejects a tampered copy with a reason, and ranks the verified wins by speed", () => {
    const recorded = run("replay", "record", "--bot", "oracle", "--seed", "7", "--out", "oracle-7.json");
    expect(recorded.code).toBe(0);
    expect(recorded.output).toMatch(/Recorded oracle on seed 7: won in \d+ turns/);
    expect(recorded.files).toHaveLength(1);
    const replay = JSON.parse(recorded.files![0]!.content) as Replay;
    files.set("oracle-7.json", recorded.files![0]!.content);

    const ok = run("replay", "verify", "oracle-7.json");
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.output).toMatch(/ok .*oracle-7\.json.*won in \d+ turns/);

    const forged = { ...replay, claimed: { ...replay.claimed, turns: replay.claimed.turns - 3 } };
    files.set("forged.json", JSON.stringify(forged));
    files.set("garbage.json", "{ not json");
    const mixed = run("replay", "verify", "oracle-7.json", "forged.json", "garbage.json", "missing.json");
    expect(mixed.code).toBe(1);
    expect(mixed.output).toMatch(/ok .*oracle-7\.json/);
    expect(mixed.output).toMatch(/REJECTED .*forged\.json.*mismatch/);
    expect(mixed.output).toMatch(/REJECTED .*garbage\.json.*malformed/);
    expect(mixed.output).toMatch(/REJECTED .*missing\.json/);

    // Ranking: a faster win beats a slower one, a tampered or lost run is left out.
    const faster = { ...replay, seed: "7" };
    files.set("same-again.json", JSON.stringify(faster));
    const lost = recordReplay({ bot: getBot("random"), seed: "7" });
    files.set("random-7.json", JSON.stringify(lost));
    const ranking = run("replay", "rank", "oracle-7.json", "same-again.json", "forged.json", "random-7.json");
    expect(ranking.code).toBe(0);
    expect(ranking.output).toMatch(/Fixed Seed 7/);
    expect(ranking.output).toMatch(/1\. .*oracle-7\.json/);
    expect(ranking.output).toMatch(/2\. .*same-again\.json/);
    expect(ranking.output).not.toMatch(/forged\.json.*turns/);
    expect(ranking.output).not.toMatch(/random-7\.json.*turns/);
    expect(ranking.output).toMatch(/Left out: forged\.json \(rejected\), random-7\.json \(not a win\)/);
    expect(run("replay", "rank", "forged.json").output).toMatch(/no verified win/);
  });

  it("explains a mistake: no sub-command, an unknown one, no bot, an unknown bot, or no files", () => {
    for (const [argv, message] of [
      [["replay"], /record, verify or rank/],
      [["replay", "dance"], /Unknown replay command "dance"/],
      [["replay", "record"], /--bot/],
      [["replay", "record", "--bot", "clever"], /Unknown bot "clever"/],
      [["replay", "verify"], /at least one file/],
      [["replay", "rank"], /at least one file/],
    ] as const) {
      const result = run(...argv);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(message);
    }
  });
});

describe("the folder of recorded replays", () => {
  const names = readdirSync(REPLAYS).filter((name) => name.endsWith(".json"));

  it("has recorded wins and losses, and every one still verifies: the regression test for the rules", () => {
    expect(names.length).toBeGreaterThanOrEqual(5);
    const claims = names.map((name) => {
      const replay = JSON.parse(readFileSync(new URL(name, REPLAYS), "utf8")) as Replay;
      const result = verifyReplay(replay);
      // If this fails, a rule changed: bump ENGINE_VERSION and re-record the folder (`pnpm sim replay record`), do not edit the files.
      expect(result, name).toEqual({ ok: true, result: replay.claimed });
      return replay.claimed.won;
    });
    expect(claims).toContain(true);
    expect(claims).toContain(false);
  });
});
