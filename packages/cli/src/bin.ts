import { createInterface } from "node:readline";
import { parseGameArgs } from "./cli";
import { play } from "./play";
import { createRunSession } from "./runSession";
import { createSession } from "./session";

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
}
