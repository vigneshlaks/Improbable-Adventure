import { describe, expect, it } from "vitest";
import { play } from "./play";
import { createSession } from "./session";

async function* feed(...lines: string[]) {
  for (const line of lines) yield line;
}

const run = async (...lines: string[]) => {
  const written: string[] = [];
  await play(createSession({ seed: "p", tier: "minion", loadout: "starting" }), feed(...lines), (text) => written.push(text));
  return written.join("");
};

describe("play", () => {
  it("prints the opening, prompts for each line and prints the replies", async () => {
    const out = await run("deploy bloom 1024", "quit");
    expect(out).toMatch(/A minion approaches/);
    expect(out).toMatch(/\] > Bloom Filter takes slot 1/); // a prompt came before the reply
    expect(out).toMatch(/Bloom Filter/);
    expect(out.trimEnd().endsWith("You leave the field.")).toBe(true);
  });

  it("stops at quit and ignores whatever comes after", async () => {
    const out = await run("quit", "deploy bloom 1024");
    expect(out).not.toMatch(/Bloom Filter.*slot/s);
  });

  it("ends quietly when the input runs out", async () => {
    await expect(run("status")).resolves.toMatch(/Turn 1/);
  });
});
