import { describe, expect, it } from "vitest";
import { buildRunConfig } from "@pda/content";
import type { RunConfig } from "@pda/engine";
import { observation, runObservation } from "./testUtils";
import { createRunSession } from "./runSession";
import { playMenu, runMap, sizeFor, type Menu, type MenuOption, type Pending } from "./playMenu";

/** The real act, with enemies that one strike of enough force kills, so a whole run is a few key presses. */
function easyConfig(seed: string, weakPoint: "frequency" | "presence"): RunConfig {
  const base = buildRunConfig({ seed });
  return { ...base, encounters: base.encounters.map((enemy) => ({ ...enemy, hp: 0.000001, weakPoints: [weakPoint] })) };
}

/** Plays the way a person pressing keys would: the first choice that works, following the steps of a choice to its command. */
function playByKeys(seed: string, pick: (menu: Menu, phase: string) => MenuOption | undefined, limit = 400) {
  const session = createRunSession({ seed, config: easyConfig(seed, "frequency") });
  const seen = new Set<string>();
  let pending: Pending = null;
  for (let i = 0; i < limit; i++) {
    const run = session.observe();
    if (run.phase === "won" || run.phase === "lost") break;
    const menu = playMenu(run, pending);
    seen.add(`${run.phase}:${run.fight?.phase ?? ""}:${run.fight?.challenge?.kind ?? ""}`);
    const option = pick(menu, run.phase) ?? (menu.entry ? { key: "", label: "typed", command: menu.entry.apply("100000").command } : undefined);
    if (!option) throw new Error(`nothing to press in ${run.phase}`);
    if (option.next !== undefined) {
      pending = option.next;
      continue;
    }
    pending = null;
    const before = JSON.stringify(run);
    const reply = session.handle(option.command as string);
    expect(JSON.stringify(session.observe()), `"${option.command}" did nothing: ${reply.lines.join(" / ")}`).not.toBe(before);
  }
  return { session, seen };
}

describe("the key menus", () => {
  it("every command a menu offers is accepted by the game, from the first deploy through rewards and rest stops to the end of a run", () => {
    const reached = new Set<string>();
    for (let n = 0; n < 3; n++) {
      let deployed = 0;
      const { session, seen } = playByKeys(`keys-${n}`, (menu) => {
        const usable = menu.options.filter((o) => !o.disabled);
        if (menu.heading.startsWith("Deploy") && deployed++ % 3 === 0) return usable[0]; // a structure, then its size
        if (menu.heading.endsWith("Space comes back.")) return usable[0];
        if (menu.heading.includes("Estimate") || menu.heading.includes("shield")) return undefined; // type the force
        return usable.find((o) => o.key === "Enter") ?? usable[0];
      });
      expect(["won", "lost"]).toContain(session.observe().phase);
      for (const s of seen) reached.add(s.split(":")[0] as string);
    }
    expect([...reached].sort()).toEqual(["fight", "rest", "reward"]);
  });

  it("a size key stays inside the free Space and is a multiple of 64 when it can be", () => {
    expect(sizeFor(8192, 1 / 8)).toBe(1024);
    expect(sizeFor(8192, 1)).toBe(8192);
    expect(sizeFor(100, 1 / 2)).toBe(50);
    expect(sizeFor(300, 1)).toBe(256);
  });

  it("marks and unmarks Presence targets, strikes the marked ones, and offers a typed number for the other challenges", () => {
    const kinds = new Set<string>();
    for (let n = 0; n < 30 && !kinds.has("presence"); n++) {
      const session = createRunSession({ seed: `marks-${n}`, config: easyConfig(`marks-${n}`, "presence") });
      const run = session.observe();
      session.handle("ready");
      session.handle("ready"); // the first stream arrives, then the next brings the challenge
      const strike = session.observe();
      const challenge = strike.fight?.challenge;
      if (!challenge) continue;
      kinds.add(challenge.kind);
      const menu = playMenu(strike, null);
      if (challenge.kind === "presence") {
        const marked = playMenu(strike, { step: "targets", picked: [0] });
        expect(marked.options.find((o) => o.key === "1")?.next).toEqual({ step: "targets", picked: [] });
        expect(marked.options.find((o) => o.key === "Enter")?.command).toBe("strike 1");
        expect(menu.options.find((o) => o.key === "Enter")?.command).toBe("strike none");
        expect(menu.options.find((o) => o.key === "2")?.next).toEqual({ step: "targets", picked: [1] });
      } else {
        expect(menu.entry?.apply("12")).toEqual({ command: "strike 12" });
      }
      expect(run.phase).toBe("fight");
    }
    expect(kinds.has("presence")).toBe(true);
  });

  it("draws the act as a row: fights behind, the current one, the next, and those ahead", () => {
    const session = createRunSession({ seed: "keys-c" });
    const states = () => runMap(session.observe(), session.tiers()).map((n) => n.state);
    expect(states()[0]).toBe("current");
    expect(states().slice(1).every((s) => s === "ahead")).toBe(true);
    expect(runMap(session.observe(), session.tiers()).at(-1)?.tier).toBe("boss");
  });

  it("handles the situations a real run reaches rarely: a full board, two enemies, a rest stop with choices, and the map after a won fight", () => {
    const full = playMenu(runObservation({ fight: observation({ slotsFree: 0 }) }));
    expect(full.options.find((o) => o.key === "1")?.disabled).toBe("every slot is in use");

    const twin = runObservation({ fight: observation({ secondTraits: observation().traits }) });
    const size = playMenu(twin, { step: "size", kind: "linearCounting" });
    expect(size.options[1]?.next).toMatchObject({ step: "enemy", kind: "linearCounting" });
    const enemy = playMenu(twin, size.options[1]?.next as Pending);
    expect(enemy.options.map((o) => o.command)).toEqual(["deploy linear 2048 on 1", "deploy linear 2048 on 2"]);

    const rest = playMenu(runObservation({ phase: "rest", fight: null, enchantable: [{ enchantmentId: "merge", kind: "bloomFilter" }] }));
    expect(rest.options.map((o) => o.command)).toEqual(["enchant merge bloom", "leave"]);

    const tiers = ["minion", "minion", "elite"] as const;
    const states = (phase: "reward" | "rest" | "won" | "lost", encounter: number) => runMap(runObservation({ phase, encounter, fight: null }), tiers).map((n) => n.state);
    expect(states("reward", 0)).toEqual(["done", "next", "ahead"]);
    expect(states("rest", 1)).toEqual(["done", "next", "ahead"]);
    expect(states("won", 2)).toEqual(["done", "done", "done"]);
    expect(states("lost", 1)).toEqual(["done", "ahead", "ahead"]);
  });
});
