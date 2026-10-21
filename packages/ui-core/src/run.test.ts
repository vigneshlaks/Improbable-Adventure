import { describe, expect, it } from "vitest";
import type { FusionDef, RewardView, RunEvent } from "@pda/engine";
import { eachCase } from "../../engine/src/testCases";
import { narrateRunStep } from "./narrator";
import { parseRunCommand, type RunParseResult } from "./parser";
import { renderQuery, renderRest, renderRewards, renderRunStatus, renderStatus } from "./views";
import { answer, observation, runObservation, view } from "./testUtils";

const offers: RewardView[] = [
  { id: "structure:countMinSketch", kind: "structure", structure: "countMinSketch" },
  { id: "upgrade:power", kind: "upgrade", upgrade: "power" },
  { id: "structure:logLog", kind: "structure", structure: "logLog" },
];
const hyper: FusionDef = { id: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" };
const reward = runObservation({ phase: "reward", fight: null, offers });
const rest = runObservation({ phase: "rest", fight: null, fusions: [hyper], owned: ["exactMemory", "logLog", "linearCounting"] });
const parse = (input: string, run = runObservation()): RunParseResult => parseRunCommand(input, run);
const errorOf = (result: RunParseResult): string => (result.kind === "error" ? result.message : `not an error: ${JSON.stringify(result)}`);

describe("parseRunCommand during a fight", () => {
  it("reads the fight's own commands exactly as the fight parser does, using the structures the run owns; explains that the run commands have to wait", () => {
    // reads the fight's own commands exactly as the fight parser does, using the structures the run owns
    {
      expect(parse("deploy bloom 2048")).toEqual({ kind: "action", action: { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 2048 } });
      expect(parse("ready")).toEqual({ kind: "action", action: { type: "endDeploy" } });
      expect(errorOf(parse("deploy cms 1024"))).toMatch(/do not own/i); // Count-Min is not owned yet
      expect(parse("deploy cms 1024", runObservation({ owned: ["countMinSketch"] })).kind).toBe("action");
      expect(parse("status")).toEqual({ kind: "info", info: "status" });
      expect(parse("quit")).toEqual({ kind: "quit" });
    }
    // explains that the run commands have to wait
    {
      for (const word of ["choose 1", "fuse", "leave", "enchant seeded bloom"]) expect(errorOf(parse(word))).toMatch(/not now|nothing to|no reward|no rest/i);
    }
  });
});

describe("parseRunCommand at the reward screen", () => {
  it("takes a reward by number, from 1, with any of three words or just the number; refuses a number that is not on offer and a choice with no number; asks for a reward before anything else, but still answers status, help and quit", () => {
    // takes a reward by number, from 1, with any of three words or just the number
    {
      eachCase(["choose 2", "take 2", "pick 2", "2", " CHOOSE   2 "].map((input) => [input, input] as const), (input) => {
        expect(parse(input, reward)).toEqual({ kind: "runAction", action: { type: "chooseReward", index: 1 } });
      });
      expect(parse("choose 1", reward)).toEqual({ kind: "runAction", action: { type: "chooseReward", index: 0 } });
      expect(parse("choose 3", reward)).toEqual({ kind: "runAction", action: { type: "chooseReward", index: 2 } });
    }
    // refuses a number that is not on offer and a choice with no number
    {
      expect(errorOf(parse("choose 4", reward))).toMatch(/1 to 3/);
      expect(errorOf(parse("choose 0", reward))).toMatch(/1 to 3/);
      expect(errorOf(parse("choose", reward))).toMatch(/Usage: choose/);
      expect(errorOf(parse("choose two", reward))).toMatch(/Usage: choose/);
    }
    // asks for a reward before anything else, but still answers status, help and quit
    {
      for (const word of ["ready", "deploy bloom 1024", "strike 1", "leave", "fuse"]) expect(errorOf(parse(word, reward))).toMatch(/reward/i);
      expect(parse("status", reward)).toEqual({ kind: "info", info: "status" });
      expect(parse("help choose", reward)).toEqual({ kind: "info", info: "help", topic: "choose" });
      expect(parse("quit", reward)).toEqual({ kind: "quit" });
    }
  });
});

describe("parseRunCommand at the rest stop", () => {
  it("leaves with any of its words; fuses a recipe by its id, its result's name or alias, or with no name when there is only one; explains a fusion that is not available, and names the ones that are; and 1 more", () => {
    // leaves with any of its words
    {
      for (const word of ["leave", "ready", "go", "done", "continue"]) {
        expect(parse(word, rest)).toEqual({ kind: "runAction", action: { type: "leaveRest" } });
      }
    }
    // fuses a recipe by its id, its result's name or alias, or with no name when there is only one
    {
      const fuse = { kind: "runAction", action: { type: "fuse", recipeId: "hyperLogLog" } };
      eachCase(["fuse hyperLogLog", "fuse hll", "fuse HyperLogLog", "fuse"].map((input) => [input, input] as const), (input) => {
        expect(parse(input, rest)).toEqual(fuse);
      });
    }
    // explains a fusion that is not available, and names the ones that are
    {
      expect(errorOf(parse("fuse bloom", rest))).toMatch(/no fusion called "bloom".*hyperLogLog|HyperLogLog/);
      const none = runObservation({ phase: "rest", fight: null, fusions: [] });
      expect(errorOf(parse("fuse", none))).toMatch(/nothing to fuse/i);
      const two = runObservation({ phase: "rest", fight: null, fusions: [hyper, { id: "other", inputs: ["bloomFilter", "countMinSketch"], result: "exactMemory" }] });
      expect(errorOf(parse("fuse", two))).toMatch(/which/i);
    }
    // asks to leave before fighting or choosing
    {
      expect(errorOf(parse("strike 1", rest))).toMatch(/rest/i);
      expect(errorOf(parse("deploy bloom 1024", rest))).toMatch(/rest/i);
      expect(errorOf(parse("choose 1", rest))).toMatch(/rest/i);
    }
  });
});

describe("parseRunCommand when the run is over", () => {
  it("says so, except for quit", () => {
    for (const phase of ["won", "lost"] as const) {
      expect(errorOf(parse("ready", runObservation({ phase, fight: null })))).toMatch(/over/i);
    }
  });
});

describe("narrateRunStep", () => {
  const run = (event: RunEvent) => narrateRunStep([event]).join(" ");

  it("announces each fight with its place in the act; describes a reward taken by name, a rest, a fusion and the ending; leaves a reward offer to the reward screen, and narrates fight events as the fight narrator does", () => {
    // announces each fight with its place in the act
    {
      expect(run({ type: "fightStarted", encounter: 2, encounters: 7, tier: "minion" })).toMatch(/Fight 3 of 7/i);
    }
    // describes a reward taken by name, a rest, a fusion and the ending
    {
      expect(run({ type: "rewardChosen", id: "structure:countMinSketch" })).toMatch(/Count-Min Sketch/);
      expect(run({ type: "rewardChosen", id: "upgrade:power" })).toMatch(/Power/);
      expect(run({ type: "restStarted", healed: 30 })).toMatch(/rest.*30/i);
      expect(run({ type: "fused", recipeId: "hyperLogLog", inputs: ["logLog", "linearCounting"], result: "hyperLogLog" })).toMatch(/LogLog and Linear Counting.*HyperLogLog/);
      expect(run({ type: "runWon", turns: 31, certaintyLeft: 88 })).toMatch(/31 turns.*88 Certainty/);
      expect(run({ type: "runLost", encounter: 5 })).toMatch(/fight 6/i);
    }
    // leaves a reward offer to the reward screen, and narrates fight events as the fight narrator does
    {
      expect(narrateRunStep([{ type: "rewardOffered", options: ["upgrade:power"] }]).join(" ")).toMatch(/won.*reward/i);
      expect(narrateRunStep([{ type: "turnStarted", turn: 3 }])).toEqual(["Turn 3."]);
    }
  });
});

describe("renderRewards", () => {
  const text = renderRewards(offers).join("\n");

  it("numbers the offers from 1, with the name, what kind it is, and what it does", () => {
    expect(text).toMatch(/1\) Count-Min Sketch \(new structure\)/);
    expect(text).toMatch(/2\) Power \(upgrade\): Every strike deals more damage/);
    expect(text).toMatch(/3\) LogLog \(new structure\)/);
    expect(renderRewards(offers, ["countMinSketch"]).join("\n")).toMatch(/1\) Count-Min Sketch \(second copy, for a fusion that needs two\)/);
  });
});

describe("renderRest", () => {
  it("lists the fusions available, with their inputs and result, and how to fuse or leave; says when there is nothing to fuse", () => {
    // lists the fusions available, with their inputs and result, and how to fuse or leave
    {
      const text = renderRest(rest).join("\n");
      expect(text).toMatch(/HyperLogLog/);
      expect(text).toMatch(/LogLog and Linear Counting/);
      expect(text).toMatch(/fuse/);
      expect(text).toMatch(/leave/);
    }
    // says when there is nothing to fuse
    {
      expect(renderRest(runObservation({ phase: "rest", fight: null, fusions: [] })).join("\n")).toMatch(/nothing to fuse/i);
    }
  });
});

describe("renderRunStatus", () => {
  it("shows where the player is in the act, the Certainty against its maximum, the owned structures and upgrades; shows the Certainty once, not again in the fight's status; adds the fight's own status during a fight, and none between fights; and 1 more", () => {
    // shows where the player is in the act, the Certainty against its maximum, the owned structures and upgrades
    {
      const text = renderRunStatus(
        runObservation({ encounter: 2, tier: "minion", certainty: 120, maxCertainty: 170, upgrades: { power: 2, slots: 1 }, owned: ["exactMemory", "hyperLogLog"] }),
      ).join("\n");
      expect(text).toMatch(/Fight 3 of 7 \(minion\)/);
      expect(text).toMatch(/Certainty: 120 of 170/);
      expect(text).toMatch(/Owned: Exact Memory, HyperLogLog/);
      expect(text).toMatch(/Upgrades: Power x2, Slots$/m); // a single one has no count
    }
    // shows the Certainty once, not again in the fight's status
    {
      expect(renderRunStatus(runObservation({ fight: observation({ turn: 2 }) })).filter((line) => line.startsWith("Certainty:"))).toHaveLength(1);
    }
    // adds the fight's own status during a fight, and none between fights
    {
      expect(renderRunStatus(runObservation({ fight: observation({ turn: 4 }) })).join("\n")).toMatch(/Turn 4, deploy phase/);
      expect(renderRunStatus(reward).join("\n")).not.toMatch(/deploy phase/);
    }
    // says no upgrades yet when there are none
    {
      expect(renderRunStatus(runObservation()).join("\n")).toMatch(/Upgrades: none/);
    }
  });
});

describe("enchantments at the screens", () => {
  const seededOffer: RewardView = { id: "enchantment:seeded", kind: "enchantment", enchantment: "seeded" };
  const enchantable = [
    { enchantmentId: "seeded", kind: "bloomFilter" as const },
    { enchantmentId: "seeded", kind: "linearCounting" as const },
  ];
  const withPack = runObservation({
    phase: "rest",
    fight: null,
    enchantments: ["seeded"],
    enchantable,
    owned: ["exactMemory", "bloomFilter", "linearCounting"],
  });

  it("lists an enchantment among the rewards with what it does; shows the structures an enchantment fits at the rest stop, and how to attach it; mentions fusions and enchantments together, and says when there is neither; and 3 more", () => {
    // lists an enchantment among the rewards with what it does
    {
      expect(renderRewards([seededOffer]).join("\n")).toMatch(/1\) Seeded \(enchantment\): Hashes with a secret seed/);
    }
    // shows the structures an enchantment fits at the rest stop, and how to attach it
    {
      const text = renderRest(withPack).join("\n");
      expect(text).toMatch(/Enchantments you can attach:/);
      expect(text).toMatch(/Seeded \(fits: Bloom Filter, Linear Counting\)/);
      expect(text).toMatch(/enchant <enchantment> <structure>/);
    }
    // mentions fusions and enchantments together, and says when there is neither
    {
      const both = renderRest({ ...withPack, fusions: [hyper] }).join("\n");
      expect(both).toMatch(/Fusions you can do:/);
      expect(both).toMatch(/Enchantments you can attach:/);
      expect(renderRest(runObservation({ phase: "rest", fight: null, fusions: [], enchantable: [] })).join("\n")).toMatch(/Nothing to fuse or enchant/);
    }
    // shows, in the run status, what is attached and what is still in the pack
    {
      const text = renderRunStatus(runObservation({ attached: { bloomFilter: "seeded" }, enchantments: ["seeded"] })).join("\n");
      expect(text).toMatch(/Enchantments: Seeded on Bloom Filter; in the pack: Seeded/);
      expect(renderRunStatus(runObservation()).join("\n")).toMatch(/Enchantments: none/);
    }
    // marks an enchanted structure by name wherever structures are listed
    {
      const enchanted = { ...view(0, "bloomFilter", answer([1], 1, 1)), enchantment: "seeded" };
      expect(renderStatus(observation({ structures: [enchanted], slotsFree: 2 })).join("\n")).toMatch(/1\. Bloom Filter \(Seeded\) \(1024 bits\)/);
      const query = renderQuery(observation({ phase: "strike", challenge: { kind: "presence", targets: [1] }, structures: [enchanted] })).join("\n");
      expect(query).toMatch(/\[1\] Bloom Filter \(Seeded\)/);
    }
    // narrates attaching, and replacing
    {
      expect(narrateRunStep([{ type: "enchanted", enchantmentId: "seeded", kind: "bloomFilter", replaced: null }]).join(" ")).toMatch(/Seeded is attached to Bloom Filter\./);
      const replacing = narrateRunStep([{ type: "enchanted", enchantmentId: "seeded", kind: "bloomFilter", replaced: "other" }]).join(" ");
      expect(replacing).toMatch(/Seeded is attached to Bloom Filter/);
      expect(replacing).toMatch(/other returns to the pack/i);
      expect(narrateRunStep([{ type: "rewardChosen", id: "enchantment:seeded" }]).join(" ")).toMatch(/You take Seeded\./);
    }
  });
});

describe("parseRunCommand: enchant", () => {
  const restWith = (enchantable: Array<{ enchantmentId: string; kind: "bloomFilter" | "linearCounting" }>) =>
    runObservation({ phase: "rest", fight: null, enchantments: ["seeded"], enchantable });
  const both = restWith([
    { enchantmentId: "seeded", kind: "bloomFilter" },
    { enchantmentId: "seeded", kind: "linearCounting" },
  ]);
  const attach = (kind: string) => ({ kind: "runAction", action: { type: "enchant", enchantmentId: "seeded", kind } });

  it("attaches an enchantment by its id or name to a structure by its alias or name; lets the structure be left out when only one fits; explains a mistake: nothing named, an unknown enchantment or structure, one that does not fit, or nothing to attach; and 1 more", () => {
    // attaches an enchantment by its id or name to a structure by its alias or name
    {
      eachCase(["enchant seeded bloom", "enchant Seeded Bloom Filter", "enchant seeded bloomFilter", " ENCHANT  seeded   bloom "].map((i) => [i, i] as const), (input) => {
        expect(parse(input, both)).toEqual(attach("bloomFilter"));
      });
      expect(parse("enchant seeded linear", both)).toEqual(attach("linearCounting"));
    }
    // lets the structure be left out when only one fits
    {
      expect(parse("enchant seeded", restWith([{ enchantmentId: "seeded", kind: "bloomFilter" }]))).toEqual(attach("bloomFilter"));
      expect(errorOf(parse("enchant seeded", both))).toMatch(/which structure.*Bloom Filter.*Linear Counting/i);
    }
    // explains a mistake: nothing named, an unknown enchantment or structure, one that does not fit, or nothing to attach
    {
      expect(errorOf(parse("enchant", both))).toMatch(/Usage: enchant/);
      expect(errorOf(parse("enchant mystery bloom", both))).toMatch(/no enchantment called "mystery"/i);
      expect(errorOf(parse("enchant seeded skiplist", both))).toMatch(/no structure called "skiplist"/i);
      expect(errorOf(parse("enchant seeded exact", both))).toMatch(/cannot be attached to Exact Memory|does not fit/i);
      expect(errorOf(parse("enchant seeded bloom", restWith([])))).toMatch(/nothing to enchant/i);
    }
    // belongs to the rest stop
    {
      expect(errorOf(parse("enchant seeded bloom", runObservation()))).toMatch(/no rest stop/i);
      expect(errorOf(parse("enchant seeded bloom", reward))).toMatch(/reward/i);
    }
  });
});
