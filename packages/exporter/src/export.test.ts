import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { structureConstants } from "@pda/content";
import type { Replay } from "@pda/engine";
import { analyzeRun, describeStrike, tradeoffProfile } from "./analysis";
import { buildToolkit } from "./export";
import { sizeBloom, sizingConstants } from "./sizing";
import { loadTemplates } from "./templates";
import { toolkitZip } from "./zip";

const replay = (name: string): Replay => JSON.parse(readFileSync(new URL(`../../../replays/${name}.json`, import.meta.url), "utf8")) as Replay;
const constants = sizingConstants(structureConstants());
const templates = loadTemplates("typescript");

describe("analysis", () => {
  it("replays a run into its fights, strikes and deployments, and a tradeoff profile in terms of production sizing", () => {
    for (const name of ["oracle-1-won", "greedy-3-won", "prober-3-won", "cautious-1-lost", "random-1-lost"]) {
      const run = replay(name);
      const analysis = analyzeRun(run);
      expect(analysis.won).toBe(run.claimed.won);
      expect(analysis.turns).toBe(run.claimed.turns);
      // A won run met every enemy and won every fight; a lost one lost exactly its last.
      expect(analysis.fights.length).toBe(run.claimed.won ? run.config.encounters.length : analysis.fights.length);
      expect(analysis.fights.filter((fight) => fight.won).length).toBe(run.claimed.won ? analysis.fights.length : analysis.fights.length - 1);
      expect(analysis.fights.reduce((sum, fight) => sum + fight.turns, 0)).toBe(run.claimed.turns);
      expect(analysis.fights.every((fight) => fight.strikes.length > 0)).toBe(true);
      expect(analysis.fights[0]?.number).toBe(1);

      // The Oracle reads the answers and deploys nothing; everyone else does.
      if (name.startsWith("oracle")) expect(analysis.deploys).toEqual([]);
      else expect(analysis.deploys.length).toBeGreaterThan(0);
      for (const entry of tradeoffProfile(analysis, constants)) {
        const mine = analysis.deploys.filter((deploy) => deploy.kind === entry.kind);
        expect(entry.deploys).toBe(mine.length);
        expect(entry.spaceRatio).toBeGreaterThan(0);
        expect(Number.isFinite(entry.spaceRatio)).toBe(true);
      }
    }
    // A Bloom Filter given exactly what production sizing asks for has a ratio of 1.
    const analysis = analyzeRun(replay("greedy-3-won"));
    const exact = { ...analysis, deploys: [{ fight: 1, kind: "bloomFilter" as const, spaceBits: sizeBloom({ items: 5000, distinct: 5000 }, constants).bits, streamSize: 5000 }] };
    expect(tradeoffProfile(exact, constants)[0]?.spaceRatio).toBeCloseTo(1, 9);
    const double = { ...exact, deploys: [{ ...exact.deploys[0]!, spaceBits: (exact.deploys[0]?.spaceBits ?? 0) * 2 }, { ...exact.deploys[0]!, spaceBits: exact.deploys[0]?.spaceBits ?? 0 }] };
    expect(tradeoffProfile(double, constants)[0]).toMatchObject({ deploys: 2 }); // mean of 2 and 1
    expect(tradeoffProfile(double, constants)[0]?.spaceRatio).toBeCloseTo(1.5, 2);
  });
});

describe("strike notes", () => {
  it("call a strike sound unless it hit decoys, was blocked, overshot by more than double, or was a miss", () => {
    const frequency = (outcome: "hit" | "blocked", force: number, trueCount: number) => describeStrike({ type: "strikeResolved", turn: 1, kind: "frequency", outcome, damage: 0, certaintyLost: 0, force, trueCount });
    expect(frequency("hit", 10, 10).good).toBe(true);
    expect(frequency("hit", 20, 10).good).toBe(true); // exactly double is still fine
    expect(frequency("hit", 21, 10).good).toBe(false);
    expect(frequency("blocked", 5, 10)).toMatchObject({ good: false, text: expect.stringContaining("too weak") });
    const presence = (realHits: number, decoyHits: number) => describeStrike({ type: "strikeResolved", turn: 1, kind: "presence", realHits, decoyHits, damage: 0, certaintyLost: 0, realTotal: 6 });
    expect(presence(4, 0).good).toBe(true); // leaving some real targets alone is caution, not a mistake
    expect(presence(4, 0).text).toContain("leaving 2 real ones unstruck");
    expect(presence(4, 1).good).toBe(false);
    const rank = (outcome: "hit" | "blocked", rankValue: number) => describeStrike({ type: "strikeResolved", turn: 1, kind: "rank", outcome, damage: 0, certaintyLost: 0, force: 5, rank: rankValue, quantile: 0.9 });
    expect(rank("blocked", 0.8)).toMatchObject({ good: false, text: expect.stringContaining("too low") });
    expect(rank("hit", 0.92).good).toBe(true);
    expect(rank("hit", 0.94).good).toBe(true);
    expect(rank("hit", 0.96).good).toBe(false); // so far above the armor that most of the damage is lost
    expect(rank("hit", 0.92).text).toContain("ranked at 92 percent against armor at 90 percent");
    const count = (outcome: "hit" | "miss") => describeStrike({ type: "strikeResolved", turn: 1, kind: "count", outcome, accuracy: 0, damage: 0, certaintyLost: 0, estimate: 150, trueDistinct: 100 });
    expect(count("hit")).toMatchObject({ good: true, text: expect.stringContaining("50% off") });
    expect(count("miss").good).toBe(false);
  });
});

describe("toolkit export", () => {
  it("writes the three documents from the run and the workload, and says what it could not size", () => {
    const files = buildToolkit({ language: "typescript", replay: replay("prober-3-won"), workload: { items: 1_000_000, distinct: 50_000, error: 0.01 }, templates, constants });
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["README.md", "SIZING.md", "FIELD_REPORT.md", "sizing.ts", "src/hash.ts", "tests/vectors.json"]));
    // A structure a fusion used up was still part of the run, so its code is in the toolkit and its fights are in the report.
    expect(files).toHaveProperty(["src/linearCounting.ts"]);
    expect(files["FIELD_REPORT.md"]).toContain("| Linear Counting |");

    const sizing = files["SIZING.md"] as string;
    const bloom = sizeBloom({ items: 1_000_000, error: 0.01 }, constants);
    expect(sizing).toContain(`${bloom.bits.toLocaleString("en-US")} bits`);
    expect(sizing).toContain(`new BloomFilter(${bloom.bits}, ${bloom.hashes})`);
    expect(sizing).toMatch(/Your run's style/);
    expect(sizing).not.toMatch(/\bNaN\b|undefined|Infinity/);

    const field = files["FIELD_REPORT.md"] as string;
    expect(field).toMatch(/Won in \d+ turns/);
    expect(field).toMatch(/\| 1 \| Minion \|/);
    expect(files["README.md"]).toContain("node --test");

    // A blank workload: defaults are stated, and a structure that needs a number it was not given says so instead of guessing.
    const blank = buildToolkit({ language: "python", replay: replay("prober-3-won"), workload: {}, templates: loadTemplates("python"), constants })["SIZING.md"] as string;
    expect(blank).toMatch(/Needs the item count/);
    expect(blank).toMatch(/default of 1%/);

    // A lost run still reports, naming the fight it ended in.
    const lost = buildToolkit({ language: "typescript", replay: replay("random-1-lost"), workload: { items: 1000 }, templates, constants })["FIELD_REPORT.md"] as string;
    expect(lost).toMatch(/Lost in fight/);
  });

  it("packs a toolkit into a zip under toolkit/ that reads back identically and is the same bytes every time", async () => {
    const files = buildToolkit({ language: "python", replay: replay("greedy-3-won"), workload: { items: 10000 }, templates: loadTemplates("python"), constants });
    const first = await toolkitZip(files);
    // Build the second one only after the clock has moved on: a zip that stamps entries with the time of day (as JSZip does for the
    // folders it makes up) differs across a second boundary, which made this test fail now and then.
    const started = Date.now();
    while (Date.now() - started < 1100) await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await toolkitZip(files);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const zip = await JSZip.loadAsync(first);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir).sort();
    expect(Object.keys(zip.files).some((name) => zip.files[name]?.dir && name.startsWith("toolkit/"))).toBe(true); // folders are real entries, with the fixed date
    expect(Object.values(zip.files).every((entry) => entry.date.getUTCFullYear() === 2000)).toBe(true);
    expect(names).toEqual(Object.keys(files).sort().map((path) => `toolkit/${path}`));
    for (const [path, content] of Object.entries(files)) expect(await zip.file(`toolkit/${path}`)?.async("string")).toBe(content);
  });
});
