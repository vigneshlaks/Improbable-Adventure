import { describe, expect, it } from "vitest";
import { createSession, type Session } from "./session";

const start = (overrides: Partial<Parameters<typeof createSession>[0]> = {}): Session =>
  createSession({ seed: "t1", tier: "minion", loadout: "starting", ...overrides });
const text = (lines: string[]) => lines.join("\n");

describe("opening", () => {
  it("shows the seed, describes the enemy, welcomes the player and shows the status", () => {
    const opening = text(start().opening());
    expect(opening).toMatch(/Seed: t1/);
    expect(opening).toMatch(/A minion approaches/);
    expect(opening).toMatch(/Type "help"/);
    expect(opening).toMatch(/Turn 1, deploy phase/);
    expect(opening).toMatch(/Certainty: 100/);
  });
});

describe("handle", () => {
  it("deploys a structure and says so, in slots numbered from 1", () => {
    const session = start();
    const { lines, done } = session.handle("deploy bloom 4096");
    expect(done).toBe(false);
    expect(text(lines)).toMatch(/Bloom Filter.*slot 1.*4096/s);
    expect(text(session.handle("status").lines)).toMatch(/1\. Bloom Filter \(4096 bits\)/);
  });

  it("explains a bad command and a typo without changing anything", () => {
    const session = start();
    expect(text(session.handle("deploi bloom 100").lines)).toMatch(/Did you mean "deploy"/);
    expect(text(session.handle("strike 3").lines)).toMatch(/no challenge yet/);
    expect(text(session.handle("deploy cms 100").lines)).toMatch(/do not own/i);
    expect(text(session.handle("status").lines)).toMatch(/No structures deployed/);
  });

  it("says nothing for an empty line", () => {
    expect(start().handle("   ")).toEqual({ lines: [], done: false });
  });

  it("lets the stream arrive on ready; turn 1 has no challenge so the next turn begins", () => {
    const session = start();
    session.handle("deploy bloom 4096");
    const out = text(session.handle("ready").lines);
    expect(out).toMatch(/200 events arrive/);
    expect(out).toMatch(/Turn 2\./); // the next turn begins
    expect(session.prompt()).toMatch(/turn 2/i);
  });

  it("issues a challenge from turn 2 and shows what the structures say about it", () => {
    const session = start();
    session.handle("deploy bloom 4096");
    session.handle("ready");
    const out = text(session.handle("ready").lines);
    expect(out).toMatch(/\[1\] Bloom Filter/);
    expect(session.prompt()).toMatch(/strike/i);
  });

  it("shows the notes the parser gives when it picks a structure for the player", () => {
    // Find a Count fight so that "strike estimate" has something to use.
    const counting = Array.from({ length: 60 }, (_, i) => start({ seed: `count-${i}`, loadout: "full" })).find((candidate) => {
      candidate.handle("deploy linear 2048");
      candidate.handle("ready");
      return /distinct values/i.test(text(candidate.handle("ready").lines));
    });
    expect(counting).toBeDefined();
    expect(text(counting!.handle("strike estimate").lines)).toMatch(/Using the Linear Counting in slot 1/);
  });

  it("lists only the structures the loadout owns in help", () => {
    const owned = text(start().handle("help").lines);
    expect(owned).toMatch(/exact:/);
    expect(owned).toMatch(/linear:/);
    expect(owned).not.toMatch(/countmin:|loglog:/);
    expect(text(start({ loadout: "full" }).handle("help").lines)).toMatch(/countmin:/);
    expect(text(start().handle("help loglog").lines)).toMatch(/do not own/i);
  });

  it("prints the Presence targets once when a challenge arrives", () => {
    const found = Array.from({ length: 80 }, (_, i) => start({ seed: `presence-${i}` })).map((session) => {
      session.handle("deploy bloom 4096");
      session.handle("ready");
      return text(session.handle("ready").lines);
    });
    const presence = found.find((out) => /dangles 12 values/.test(out));
    expect(presence).toBeDefined();
    expect(presence!.match(/^ *1\) \d+/gm)).toHaveLength(1);
  });

  it("tells the player the true answer after a strike", () => {
    const outcomes = Array.from({ length: 60 }, (_, i) => {
      const session = start({ seed: `truth-${i}`, loadout: "full" });
      session.handle("deploy linear 4096");
      session.handle("ready");
      const challenge = text(session.handle("ready").lines);
      if (/distinct values are in the stream/i.test(challenge)) return text(session.handle("strike estimate").lines);
      if (/how many times has it appeared/i.test(challenge)) return text(session.handle("strike 5").lines);
      return "";
    });
    expect(outcomes.some((out) => /There were \d+ distinct values; you said \d+/.test(out))).toBe(true);
    expect(outcomes.some((out) => /The value had appeared \d+ times; you struck with 5/.test(out))).toBe(true);
  });

  it("answers help and query without touching the fight", () => {
    const session = start();
    expect(text(session.handle("help").lines)).toMatch(/Commands:/);
    expect(text(session.handle("help bloom").lines)).toMatch(/Bloom Filter/);
    expect(text(session.handle("query").lines)).toMatch(/nothing to ask/i);
    expect(text(session.handle("status").lines)).toMatch(/Turn 1, deploy phase/);
  });

  it("ends on quit, with a goodbye", () => {
    const { lines, done } = start().handle("quit");
    expect(done).toBe(true);
    expect(text(lines).length).toBeGreaterThan(0);
  });

  it("does nothing more after quit", () => {
    const session = start();
    session.handle("quit");
    expect(session.handle("deploy bloom 1024")).toEqual({ lines: [], done: true });
    expect(text(session.handle("status").lines)).toBe("");
  });
});

describe("a whole fight", () => {
  /** Plays by readying and striking something every turn, until the fight is over. */
  function playOut(session: Session): string[] {
    const all: string[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const phase = /strike/.test(session.prompt()) ? "strike" : "deploy";
      const { lines, done } = session.handle(phase === "strike" ? "strike 1" : "ready");
      const out = text(lines);
      all.push(out);
      // A Presence challenge wants target numbers; a number-only strike is a mistake there. Fall back to "none".
      if (/Choose targets by number/.test(out)) all.push(text(session.handle("strike none").lines));
      if (done) return all;
    }
    throw new Error("The fight never ended");
  }

  it("reaches an ending, reports it, and then stays finished", () => {
    const session = start({ seed: "end" });
    const transcript = text(playOut(session));
    expect(transcript).toMatch(/You win|The fight is lost|Your Certainty is gone/);
    const after = session.handle("ready");
    expect(after.done).toBe(true);
  });

  it("is the same every time for the same seed and commands", () => {
    const a = text(playOut(start({ seed: "same" })));
    const b = text(playOut(start({ seed: "same" })));
    expect(a).toBe(b);
    expect(text(playOut(start({ seed: "other" })))).not.toBe(a);
  });
});

describe("prompt", () => {
  it("shows the turn, the phase and the main resources", () => {
    const prompt = start().prompt();
    expect(prompt).toMatch(/turn 1/i);
    expect(prompt).toMatch(/deploy/i);
    expect(prompt).toMatch(/Certainty 100/);
    expect(prompt).toMatch(/8192 bits/);
    expect(prompt.endsWith("> ")).toBe(true);
  });
});
