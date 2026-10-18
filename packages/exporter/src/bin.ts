import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentHash, structureConstants } from "@pda/content";
import { STRUCTURE_KINDS, verifyReplay, type Replay, type StructureKind } from "@pda/engine";
import { buildToolkit } from "./export";
import { sizingConstants, type Workload } from "./sizing";
import { loadTemplates, VECTORS_PATH } from "./templates";
import { generateToolkit, type Language } from "./toolkit";
import { buildVectors } from "./vectors";
import { toolkitZip } from "./zip";

const USAGE = `Usage:
  export vectors                              rewrite the shared known answers from the game's own structures
  export generate <typescript|python> <dir>   write a toolkit with every structure into <dir>
  export toolkit <typescript|python> <replay.json> <out.zip> [--items N] [--distinct N] [--error E] [--memory BITS]
                                              verify a recorded run, then write the zip for the structures it ended with, sized for your workload
  export check                                generate both toolkits and run their tests with each language's own toolchain`;

function write(files: Record<string, string>, dir: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function run(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  return result.status === 0;
}

/** The generated TypeScript must also type-check under strict settings, not just run (the tests are run by Node, which does not check types). */
function typeCheck(dir: string): boolean {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const sources = ["sizing.ts", ...readdirSync(join(dir, "src")).map((name) => `src/${name}`)];
  const flags = ["--noEmit", "--strict", "--noUncheckedIndexedAccess", "--allowImportingTsExtensions", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2022,dom", "--skipLibCheck"];
  return run(process.execPath, [tsc, ...flags, ...sources], dir);
}

const FLAGS: Record<string, keyof Workload> = { "--items": "items", "--distinct": "distinct", "--error": "error", "--memory": "memoryBits" };

function workloadFrom(args: string[]): Workload | null {
  const workload: Workload = {};
  for (let i = 0; i < args.length; i += 2) {
    const field = FLAGS[args[i] as string];
    const value = Number(args[i + 1]);
    if (!field || !Number.isFinite(value)) return null;
    workload[field] = value;
  }
  return workload;
}

async function toolkit(language: Language, replayPath: string, outPath: string, rest: string[]): Promise<number> {
  const workload = workloadFrom(rest);
  if (!workload) {
    console.error(USAGE);
    return 2;
  }
  const replay = JSON.parse(readFileSync(replayPath, "utf8")) as Replay;
  const verdict = verifyReplay(replay, { contentHash: contentHash() });
  if (!verdict.ok) {
    console.error(`The replay does not verify (${verdict.reason}): ${verdict.message}`);
    return 1;
  }
  const files = buildToolkit({ language, replay, workload, templates: loadTemplates(language), constants: sizingConstants(structureConstants()) });
  writeFileSync(outPath, await toolkitZip(files));
  console.log(`Wrote ${outPath} (${Object.keys(files).length} files)`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, language, dir] = argv;
  const owned: StructureKind[] = [...STRUCTURE_KINDS];
  if (command === "vectors") {
    writeFileSync(VECTORS_PATH, `${JSON.stringify(buildVectors(structureConstants()), null, 2)}\n`);
    return 0;
  }
  if (command === "generate" && (language === "typescript" || language === "python") && dir) {
    write(generateToolkit(language, owned, loadTemplates(language)), dir);
    return 0;
  }
  if (command === "toolkit" && (language === "typescript" || language === "python") && dir && argv[3]) return toolkit(language, dir, argv[3], argv.slice(4));
  if (command === "check") {
    const root = mkdtempSync(join(tmpdir(), "toolkit-"));
    try {
      const results = (["typescript", "python"] as Language[]).map((lang) => {
        const target = join(root, lang);
        write(generateToolkit(lang, owned, loadTemplates(lang)), target);
        return lang === "typescript" ? typeCheck(target) && run("node", ["--test", "tests/*.test.ts"], target) : run("python3", ["-m", "pytest", "-q"], target);
      });
      return results.every(Boolean) ? 0 : 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.error(USAGE);
  return 2;
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
