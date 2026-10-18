import type { Session } from "@pda/ui-core";

/**
 * Runs a session against a source of typed lines. Each reply is written as it is produced, and the loop ends when
 * the fight is over, the player quits, or the lines run out.
 */
export async function play(session: Session, input: AsyncIterable<string>, write: (text: string) => void): Promise<void> {
  write(`${session.opening().join("\n")}\n`);
  write(session.prompt());
  for await (const line of input) {
    const { lines, done } = session.handle(line);
    if (lines.length > 0) write(`${lines.join("\n")}\n`);
    if (done) return;
    write(session.prompt());
  }
  write("\n");
}
