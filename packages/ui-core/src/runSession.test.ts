import { describe, expect, it } from "vitest";
import { balance, buildRunConfig, contentHash } from "@pda/content";
import { verifyReplay, type RunConfig } from "@pda/engine";
import { createRunSession, type RunSession } from "./runSession";
import type { Session } from "./session";

const text = (lines: string[]) => lines.join("\n");

/** The real act, with enemies that any Frequency strike of enough force kills, so whole runs can be played in a few commands. */
function easyConfig(seed: string, overrides: Partial<RunConfig> = {}): RunConfig {
  const base = buildRunConfig({ seed });
  return { ...base, encounters: base.encounters.map((enemy) => ({ ...enemy, hp: 0.000001, weakPoints: ["frequency" as const] })), ...overrides };
}
const start = (seed = "r1", overrides: Partial<RunConfig> = {}): RunSession => createRunSession({ seed, config: easyConfig(seed, overrides) });

/** Wins the fight in progress: the first stream arrives, then the second brings the challenge, which a huge force beats. */
function winFight(session: Session): string {
  const out = [session.handle("ready"), session.handle("ready"), session.handle("strike 100000")];
  return out.map((reply) => text(reply.lines)).join("\n");
}

/** Plays commands until the session says it is done, choosing the first reward and leaving every rest stop. */
function playOut(session: Session, rest: (session: Session) => string = () => text(session.handle("leave").lines)): string {
  const all: string[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const prompt = session.prompt();
    if (/\[reward/.test(prompt)) all.push(text(session.handle("choose 1").lines));
    else if (/\[rest stop/.test(prompt)) all.push(rest(session));
    else {
      const reply = session.handle(/strike/.test(prompt) ? "strike 100000" : "ready");
      all.push(text(reply.lines));
      if (reply.done) return all.join("\n");
    }
  }
  throw new Error("The run never ended");
}

describe("opening", () => {
  it("shows the seed, how a run works, the first fight and the enemy, and where the player stands", () => {
    const opening = text(start().opening());
    expect(opening).toMatch(/Seed: r1/);
    expect(opening).toMatch(/An act lies ahead/);
    expect(opening).toMatch(/Fight 1 of 7\./);
    expect(opening).toMatch(/A minion approaches/);
    expect(opening).toMatch(/Fight 1 of 7 \(minion\)/);
    expect(opening).toMatch(new RegExp(`Certainty: ${balance.STARTING_CERTAINTY} of ${balance.STARTING_CERTAINTY}`));
  });
});

describe("prompt", () => {
  it("shows the fight, the turn, the phase and the resources while fighting; names the reward screen and the rest stop", () => {
    // shows the fight, the turn, the phase and the resources while fighting
    {
      const prompt = start().prompt();
      expect(prompt).toMatch(/^\[fight 1\/7 turn 1 deploy /);
      expect(prompt).toMatch(new RegExp(`Certainty ${balance.STARTING_CERTAINTY}/${balance.STARTING_CERTAINTY}`));
      expect(prompt.endsWith("> ")).toBe(true);
    }
    // names the reward screen and the rest stop
    {
      const session = start();
      winFight(session);
      expect(session.prompt()).toMatch(/^\[reward after fight 1\/7 /);
    }
  });
});

describe("a fight in the run", () => {
  it("plays like a single fight: the commands, the stream, the challenge with its answers; prints the Presence targets once, with the structures' flags, when the challenge arrives; refuses the choices that belong to other screens, saying why", () => {
    // plays like a single fight: the commands, the stream, the challenge with its answers
    {
      const session = start();
      expect(text(session.handle("deploy bloom 2048").lines)).toMatch(/Bloom Filter takes slot 1/);
      expect(text(session.handle("ready").lines)).toMatch(/200 events arrive/);
      const challenge = text(session.handle("ready").lines);
      expect(challenge).toMatch(/Shield on the value/);
      expect(challenge).toMatch(/\[1\] Bloom Filter/);
    }
    // prints the Presence targets once, with the structures' flags, when the challenge arrives
    {
      const base = easyConfig("pres");
      const session = createRunSession({ seed: "pres", config: { ...base, encounters: base.encounters.map((enemy) => ({ ...enemy, weakPoints: ["presence" as const] })) } });
      session.handle("deploy bloom 4096");
      session.handle("ready");
      const out = text(session.handle("ready").lines);
      expect(out).toMatch(/shows you 12 values/);
      expect(out.match(/^ *1\) \d+/gm)).toHaveLength(1);
    }
    // refuses the choices that belong to other screens, saying why
    {
      const session = start();
      expect(text(session.handle("choose 1").lines)).toMatch(/no reward/i);
      expect(text(session.handle("leave").lines)).toMatch(/no rest stop/i);
    }
  });
});

describe("rewards", () => {
  it("shows the offers numbered from 1 when a fight is won, with what each does; takes the chosen reward, starts the next fight and describes its enemy; makes a new structure available to deploy and shows it in the status; and 1 more", () => {
    // shows the offers numbered from 1 when a fight is won, with what each does
    {
      const session = start();
      const out = winFight(session);
      expect(out).toMatch(/The fight is won\. Choose a reward:/);
      expect(out).toMatch(/\n {2}1\) /);
      expect(out).toMatch(/\n {2}2\) /);
      expect(out).toMatch(/\n {2}3\) /);
      expect(out).toMatch(/\((new structure|upgrade)\)/);
    }
    // takes the chosen reward, starts the next fight and describes its enemy
    {
      const session = start();
      winFight(session);
      const out = text(session.handle("choose 2").lines);
      expect(out).toMatch(/You take /);
      expect(out).toMatch(/Fight 2 of 7\./);
      expect(out).toMatch(/approaches|looms/);
      expect(session.prompt()).toMatch(/^\[fight 2\/7 turn 1 deploy /);
    }
    // makes a new structure available to deploy and shows it in the status
    {
      const session = start("r1", { rewards: [{ id: "structure:countMinSketch", kind: "structure", structure: "countMinSketch", weight: 1 }] });
      winFight(session);
      session.handle("choose 1");
      expect(text(session.handle("status").lines)).toMatch(/Owned: .*Count-Min Sketch/);
      expect(text(session.handle("deploy cms 2048").lines)).toMatch(/Count-Min Sketch takes slot 1/);
    }
    // explains a bad choice, and asks for a reward before anything else
    {
      const session = start();
      winFight(session);
      expect(text(session.handle("choose 9").lines)).toMatch(/1 to 3/);
      expect(text(session.handle("ready").lines)).toMatch(/Choose a reward first/);
      expect(text(session.handle("status").lines)).toMatch(/Fight 1 of 7/); // still on the reward screen
      expect(session.prompt()).toMatch(/\[reward/);
    }
  });
});

describe("the rest stop and fusions", () => {
  /** Only LogLog is ever offered, so the player owns it by the rest stop, which makes a fusion available. */
  const withLogLog = () => start("rest", { rewards: [{ id: "structure:logLog", kind: "structure", structure: "logLog", weight: 1 }] });
  function toRest(session: Session): string {
    const seen: string[] = [];
    for (let guard = 0; guard < 100 && !/\[rest stop/.test(session.prompt()); guard++) {
      const prompt = session.prompt();
      if (/\[reward/.test(prompt)) seen.push(text(session.handle("choose 1").lines));
      else seen.push(winFight(session));
    }
    return seen.join("\n");
  }

  it("comes after the fifth fight, heals, and lists the fusions that can be done; fuses on request, by name, using the originals up; goes on to the Elite when the player leaves; and 1 more", () => {
    // comes after the fifth fight, heals, and lists the fusions that can be done
    {
      const session = withLogLog();
      const out = toRest(session);
      expect(out).toMatch(/You reach a rest stop and recover/);
      expect(out).toMatch(/Fusions you can do:/);
      expect(out).toMatch(/LogLog and Linear Counting become HyperLogLog/);
      expect(session.prompt()).toMatch(/^\[rest stop /);
    }
    // fuses on request, by name, using the originals up
    {
      const session = withLogLog();
      toRest(session);
      const out = text(session.handle("fuse hll").lines);
      expect(out).toMatch(/LogLog and Linear Counting fuse into HyperLogLog/);
      const status = text(session.handle("status").lines);
      expect(status).toMatch(/Owned: .*HyperLogLog/);
      expect(status).not.toMatch(/Owned: .*LogLog,|Linear Counting/);
      expect(text(session.handle("fuse").lines)).toMatch(/nothing to fuse/i);
    }
    // goes on to the Elite when the player leaves
    {
      const session = withLogLog();
      toRest(session);
      const out = text(session.handle("leave").lines);
      expect(out).toMatch(/Fight 6 of 7\./);
      expect(out).toMatch(/elite/i);
    }
    // does not offer a fusion the player cannot do
    {
      const session = start("rest", { rewards: [{ id: "upgrade:power", kind: "upgrade", upgrade: "power", weight: 1 }] });
      expect(toRest(session)).toMatch(/Nothing to fuse/);
    }
  });
});

describe("enchantments", () => {
  /** Only Seeded is ever offered, so by the rest stop the player holds two of it. */
  const seededOnly = () => start("ench", { rewards: [{ id: "enchantment:seeded", kind: "enchantment", enchantment: "seeded", weight: 1 }] });
  function toRest(session: Session): void {
    for (let guard = 0; guard < 100 && !/\[rest stop/.test(session.prompt()); guard++) {
      if (/\[reward/.test(session.prompt())) session.handle("choose 1");
      else winFight(session);
    }
  }

  it("is offered as a reward with what it does, and goes into the pack when taken; is attached at the rest stop, and the structure is shown enchanted in the next fight; lists what can be attached at the rest stop, and explains a mistake; and 1 more", () => {
    // is offered as a reward with what it does, and goes into the pack when taken
    {
      const session = seededOnly();
      const offer = winFight(session);
      expect(offer).toMatch(/1\) Seeded \(enchantment\): Hashes with a secret seed/);
      expect(text(session.handle("choose 1").lines)).toMatch(/You take Seeded\./);
      expect(text(session.handle("status").lines)).toMatch(/Enchantments: in the pack: Seeded/);
    }
    // is attached at the rest stop, and the structure is shown enchanted in the next fight
    {
      const session = seededOnly();
      toRest(session);
      const rest = text(session.handle("status").lines);
      expect(rest).toMatch(/Enchantments: in the pack: Seeded, Seeded/);
      expect(text(session.handle("enchant seeded bloom").lines)).toMatch(/Seeded is attached to Bloom Filter\./);
      expect(text(session.handle("status").lines)).toMatch(/Enchantments: Seeded on Bloom Filter; in the pack: Seeded/);
      session.handle("leave");
      expect(text(session.handle("deploy bloom 2048").lines)).toMatch(/Bloom Filter takes slot 1/);
      expect(text(session.handle("status").lines)).toMatch(/1\. Bloom Filter \(Seeded\) \(2048 bits\)/);
    }
    // lists what can be attached at the rest stop, and explains a mistake
    {
      const session = seededOnly();
      toRest(session);
      expect(text(session.handle("status").lines)).toMatch(/Fight 6 of 7/);
      const mistakes = [session.handle("enchant seeded exact"), session.handle("enchant mystery bloom"), session.handle("enchant")].map((reply) => text(reply.lines));
      expect(mistakes[0]).toMatch(/cannot be attached to Exact Memory/);
      expect(mistakes[1]).toMatch(/no enchantment called "mystery"/);
      expect(mistakes[2]).toMatch(/Usage: enchant/);
    }
    // is refused in a fight and on the reward screen
    {
      const session = seededOnly();
      expect(text(session.handle("enchant seeded bloom").lines)).toMatch(/no rest stop/i);
      winFight(session);
      expect(text(session.handle("enchant seeded bloom").lines)).toMatch(/Choose a reward first/);
    }
  });
});

describe("the end of a run", () => {
  it("is won by beating the last fight, says so with the turns and the Certainty left, and then stays finished; is lost when a fight is lost, and says which fight; is the same every time for the same seed and commands; and 1 more", () => {
    // is won by beating the last fight, says so with the turns and the Certainty left, and then stays finished
    {
      const session = start("win");
      const out = playOut(session);
      expect(out).toMatch(/The act is won in \d+ turns, with \d+ Certainty left\./);
      expect(session.handle("ready")).toEqual({ lines: [], done: true });
    }
    // is lost when a fight is lost, and says which fight
    {
      const deadly = easyConfig("lose");
      const session = createRunSession({ seed: "lose", config: { ...deadly, encounters: deadly.encounters.map((enemy) => ({ ...enemy, attack: 10_000 })) } });
      const reply = session.handle("ready");
      expect(text(reply.lines)).toMatch(/The run ends in fight 1\./);
      expect(reply.done).toBe(true);
    }
    // is the same every time for the same seed and commands
    {
      expect(playOut(start("same"))).toBe(playOut(start("same")));
      expect(playOut(start("other"))).not.toBe(playOut(start("same")));
    }
    // keeps a replay of a run that finished, which verifies, and none of one that was left
    {
      const won = start("replay-win");
      expect(won.replay()).toBeNull(); // nothing to claim yet
      playOut(won);
      const replay = won.replay()!;
      expect(replay.claimed.won).toBe(true);
      expect(verifyReplay(JSON.parse(JSON.stringify(replay)))).toEqual({ ok: true, result: replay.claimed });
      expect(replay.contentHash).toBe(contentHash());

      const deadly = easyConfig("replay-lose");
      const lost = createRunSession({ seed: "replay-lose", config: { ...deadly, encounters: deadly.encounters.map((enemy) => ({ ...enemy, attack: 10_000 })) } });
      lost.handle("ready");
      expect(lost.replay()?.claimed.won).toBe(false);
      expect(verifyReplay(lost.replay())).toMatchObject({ ok: true });

      const left = start("replay-quit");
      winFight(left);
      left.handle("quit");
      expect(left.replay()).toBeNull(); // a run that was left has no result
    }
    // ends on quit, from any screen
    {
      const session = start();
      winFight(session);
      const reply = session.handle("quit");
      expect(reply.done).toBe(true);
      expect(text(reply.lines)).toMatch(/leave the field/i);
      expect(session.handle("choose 1")).toEqual({ lines: [], done: true });
    }
  });
});

describe("help, status and mistakes", () => {
  it("explains the run commands and lists only the structures owned; gives the run status at every stage; says nothing for an empty line, and suggests the command for a typo on the screen where it applies", () => {
    // explains the run commands and lists only the structures owned
    {
      const help = text(start().handle("help").lines);
      expect(help).toMatch(/choose <number>/);
      expect(help).toMatch(/fuse \[name\]/);
      expect(help).toMatch(/leave/);
      expect(help).not.toMatch(/countmin:/); // not owned yet
    }
    // gives the run status at every stage
    {
      const session = start();
      expect(text(session.handle("status").lines)).toMatch(/Fight 1 of 7 \(minion\)[\s\S]*Turn 1, deploy phase/);
      winFight(session);
      expect(text(session.handle("status").lines)).toMatch(/Upgrades: none/);
    }
    // says nothing for an empty line, and suggests the command for a typo on the screen where it applies
    {
      const session = start();
      expect(session.handle("  ")).toEqual({ lines: [], done: false });
      expect(text(session.handle("raedy").lines)).toMatch(/Did you mean "ready"/); // in a fight
      winFight(session);
      expect(text(session.handle("chose 1").lines)).toMatch(/Did you mean "choose"/); // at the reward screen
    }
  });
});
