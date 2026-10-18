import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseGameArgs } from "./cli";
import { play } from "./play";
import { createRunSession, createSession, type RunSession } from "@pda/ui-core";

const parsed = parseGameArgs(process.argv.slice(2), { defaultSeed: String(Date.now()) });
if (!parsed.ok) {
  console.log(parsed.message);
  process.exitCode = parsed.message.startsWith("Usage:") ? 0 : 1;
} else {
  // No `output`: the terminal echoes what is typed, and the game writes its own prompt.
  const input = createInterface({ input: process.stdin });
  const session = parsed.mode === "run" ? createRunSession(parsed.options) : createSession(parsed.options);
  await play(session, input, (text) => process.stdout.write(text));
  input.close();
  if (parsed.mode === "run" && parsed.options.record !== undefined) {
    const replay = (session as RunSession).replay();
    if (replay) {
      writeFileSync(parsed.options.record, JSON.stringify(replay));
      console.log(`Replay saved to ${parsed.options.record}.`);
    } else console.log("The run was not finished, so no replay was saved.");
  }
}
