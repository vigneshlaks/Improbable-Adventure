import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import type { Observation, StructureKind } from "@pda/engine";
import { parseCommand, type ParseResult } from "./parser";
import { answer, observation, view } from "./testUtils";

const parse = (input: string, obs: Observation = observation(), loadout?: StructureKind[]): ParseResult =>
  parseCommand(input, { observation: obs, loadout });

const errorOf = (result: ParseResult): string => {
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
};

describe("blank input and quitting", () => {
  it("treats blank input as nothing", () => {
    expect(parse("")).toEqual({ kind: "empty" });
    expect(parse("   \t ")).toEqual({ kind: "empty" });
  });

  it("recognizes quit and its aliases", () => {
    for (const word of ["quit", "exit", "q"]) expect(parse(word)).toEqual({ kind: "quit" });
  });
});

describe("deploy", () => {
  it("places a structure in the first free slot", () => {
    expect(parse("deploy bloom 6000 600")).toEqual({
      kind: "action",
      action: { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 6000, knob: 600 },
    });
  });

  it("ignores case and extra spaces, and omits the knob when none is given", () => {
    const result = parse("  DEPLOY   Bloom    2048 ");
    expect(result).toEqual({ kind: "action", action: { type: "deploy", slot: 0, kind: "bloomFilter", spaceBits: 2048 } });
    expect(result.kind === "action" && "knob" in result.action).toBe(false);
  });

  it("accepts every structure alias", () => {
    const aliases: Array<[string, string]> = [
      ["exact", "exactMemory"],
      ["reservoir", "reservoirSampling"],
      ["bloom", "bloomFilter"],
      ["cms", "countMinSketch"],
      ["countmin", "countMinSketch"],
      ["loglog", "logLog"],
      ["linear", "linearCounting"],
    ];
    eachCase(aliases.map((pair) => [pair[0], pair] as const), ([alias, kind]) => {
      expect(parse(`deploy ${alias} 1024`)).toMatchObject({ kind: "action", action: { type: "deploy", kind } });
    });
  });

  it("accepts a structure's full name", () => {
    expect(parse("deploy count-min sketch 4096 3")).toMatchObject({
      action: { kind: "countMinSketch", spaceBits: 4096, knob: 3 },
    });
  });

  it("uses the first free slot", () => {
    const obs = observation({ slotsFree: 1, structures: [view(0, "bloomFilter"), view(2, "logLog")] });
    expect(parse("deploy exact 512", obs)).toMatchObject({ action: { slot: 1 } });
  });

  it("explains a mistake", () => {
    expect(errorOf(parse("deploy"))).toMatch(/Usage: deploy/);
    expect(errorOf(parse("deploy bloom"))).toMatch(/Usage: deploy/);
    expect(errorOf(parse("deploy bloom lots"))).toMatch(/Usage: deploy/);
    expect(errorOf(parse("deploy skiplist 1024"))).toMatch(/no structure called "skiplist"/);
    expect(errorOf(parse("deploy bloom 0"))).toMatch(/whole number of bits/);
    expect(errorOf(parse("deploy bloom 10.5"))).toMatch(/whole number of bits/);
    expect(errorOf(parse("deploy bloom 9000"))).toMatch(/Only 8192 bits/);
    expect(errorOf(parse("deploy bloom 1024 5 6"))).toMatch(/Usage: deploy/);
  });

  it("suggests the closest structure for a typo", () => {
    expect(errorOf(parse("deploy blom 1024"))).toMatch(/Did you mean "bloom"/);
  });

  it("checks the knob against the structure's range", () => {
    expect(errorOf(parse("deploy exact 1024 5"))).toMatch(/Exact Memory has no knob/);
    expect(errorOf(parse("deploy cms 4096 0"))).toMatch(/depth must be between 1 and 16/);
    expect(errorOf(parse("deploy cms 4096 99"))).toMatch(/depth must be between 1 and 16/);
  });

  it("refuses a structure the player does not own", () => {
    expect(errorOf(parse("deploy cms 4096", observation(), ["bloomFilter"]))).toMatch(/do not own Count-Min Sketch/);
    expect(parse("deploy bloom 4096", observation(), ["bloomFilter"]).kind).toBe("action");
  });

  it("refuses when every slot is in use", () => {
    const obs = observation({ slotsFree: 0, structures: [view(0, "bloomFilter"), view(1, "logLog"), view(2, "exactMemory")] });
    expect(errorOf(parse("deploy cms 1024", obs))).toMatch(/Every slot is in use/);
  });

  it("only works while deploying", () => {
    const striking = observation({ phase: "strike", challenge: { kind: "count" } });
    expect(errorOf(parse("deploy bloom 1024", striking))).toMatch(/Answer the challenge/);
    expect(errorOf(parse("deploy bloom 1024", observation({ phase: "won" })))).toMatch(/fight is over/);
  });
});

describe("remove and ready", () => {
  const deployed = observation({ slotsFree: 1, structures: [view(0, "bloomFilter"), view(1, "logLog")] });

  it("numbers slots from 1", () => {
    expect(parse("remove 2", deployed)).toEqual({ kind: "action", action: { type: "remove", slot: 1 } });
    expect(parse("remove 1", deployed)).toEqual({ kind: "action", action: { type: "remove", slot: 0 } });
  });

  it("explains a mistake", () => {
    expect(errorOf(parse("remove", deployed))).toMatch(/Usage: remove/);
    expect(errorOf(parse("remove two", deployed))).toMatch(/Usage: remove/);
    expect(errorOf(parse("remove 9", deployed))).toMatch(/slots are numbered 1 to 3/);
    expect(errorOf(parse("remove 3", deployed))).toMatch(/Slot 3 is empty/);
  });

  it("ready finishes deploying, in any case and with its aliases", () => {
    for (const word of ["ready", "READY", "go", "done"]) expect(parse(word)).toEqual({ kind: "action", action: { type: "endDeploy" } });
    expect(errorOf(parse("ready", observation({ phase: "strike", challenge: { kind: "count" } })))).toMatch(/Answer the challenge/);
  });
});

describe("information commands", () => {
  it("passes status, query and help through without an action", () => {
    expect(parse("status")).toEqual({ kind: "info", info: "status" });
    expect(parse("query")).toEqual({ kind: "info", info: "query" });
    expect(parse("help")).toEqual({ kind: "info", info: "help" });
    expect(parse("?")).toEqual({ kind: "info", info: "help" });
  });

  it("keeps the topic of a help request", () => {
    expect(parse("help bloom")).toEqual({ kind: "info", info: "help", topic: "bloom" });
    expect(parse("help count-min sketch")).toEqual({ kind: "info", info: "help", topic: "count-min sketch" });
  });
});

describe("strike: Frequency and Count", () => {
  // Slot 0 (displayed as 1) says 95 with range 66 to 95; slot 1 (displayed as 2) says 90.4 with range 70.2 to 120.5.
  const frequency = observation({
    phase: "strike",
    turn: 2,
    challenge: { kind: "frequency", value: 777 },
    structures: [
      view(0, "countMinSketch", answer(95, 66, 95)),
      view(1, "reservoirSampling", answer(90.4, 70.2, 120.5)),
      view(2, "bloomFilter", null),
    ],
  });

  it("strikes with a number", () => {
    expect(parse("strike 130", frequency)).toEqual({ kind: "action", action: { type: "strikeValue", value: 130 } });
    expect(parse("strike 12.5", frequency)).toEqual({ kind: "action", action: { type: "strikeValue", value: 12.5 } });
  });

  it("strikes at a structure's estimate, upper bound or lower bound, rounded sensibly", () => {
    expect(parse("strike estimate", frequency)).toMatchObject({ action: { value: 95 } });
    expect(parse("strike high", frequency)).toMatchObject({ action: { value: 95 } });
    expect(parse("strike low", frequency)).toMatchObject({ action: { value: 66 } });
  });

  it("uses the first structure that has an answer, and says which", () => {
    const result = parse("strike high", frequency);
    expect(result).toMatchObject({ kind: "action", note: expect.stringMatching(/Count-Min Sketch in slot 1/) });
  });

  it("can name the structure to use", () => {
    const result = parse("strike high 2", frequency);
    expect(result).toMatchObject({ action: { type: "strikeValue", value: 121 }, note: expect.stringMatching(/Reservoir Sampling in slot 2/) });
    expect(parse("strike estimate 2", frequency)).toMatchObject({ action: { value: 90 } });
    expect(parse("strike low 2", frequency)).toMatchObject({ action: { value: 70 } });
  });

  it("explains a mistake", () => {
    expect(errorOf(parse("strike", frequency))).toMatch(/Strike with a number/);
    expect(errorOf(parse("strike many", frequency))).toMatch(/Strike with a number/);
    expect(errorOf(parse("strike -5", frequency))).toMatch(/Strike with a number/);
    expect(errorOf(parse("strike 1 2", frequency))).toMatch(/Strike with a number/);
    expect(errorOf(parse("strike high 3", frequency))).toMatch(/Bloom Filter in slot 3 has no answer/);
    expect(errorOf(parse("strike high 9", frequency))).toMatch(/no structure in slot 9/);
    expect(errorOf(parse("strike confirmed", frequency))).toMatch(/Strike with a number/);
  });

  it("refuses a bound that does not exist", () => {
    const open = observation({
      phase: "strike",
      challenge: { kind: "count" },
      structures: [view(0, "linearCounting", answer(300, 200, Infinity))],
    });
    expect(errorOf(parse("strike high", open))).toMatch(/no upper limit/);
    expect(parse("strike low", open)).toMatchObject({ action: { value: 200 } });
  });

  it("explains when no structure can help", () => {
    const blind = observation({ phase: "strike", challenge: { kind: "count" }, structures: [view(0, "bloomFilter", null)] });
    expect(errorOf(parse("strike estimate", blind))).toMatch(/No deployed structure/);
    expect(parse("strike 40", blind)).toMatchObject({ action: { value: 40 } });
  });

  it("only works while there is a challenge", () => {
    expect(errorOf(parse("strike 5"))).toMatch(/no challenge/);
    expect(errorOf(parse("strike 5", observation({ phase: "lost" })))).toMatch(/fight is over/);
  });
});

describe("strike: Presence", () => {
  // Six targets. Slot 1 flags targets 1, 3, 5. Slot 2 flags targets 3, 5, 6. Targets 3 and 5 are confirmed.
  const targets = [101, 102, 103, 104, 105, 106];
  const presence = (flagsA: number[], flagsB: number[]): Observation =>
    observation({
      phase: "strike",
      challenge: { kind: "presence", targets },
      structures: [view(0, "bloomFilter", answer(flagsA, 1, 3)), view(1, "exactMemory", answer(flagsB, 2, 3))],
    });
  const obs = presence([101, 103, 105], [103, 105, 106]);

  it("strikes the targets named, numbered from 1", () => {
    expect(parse("strike 1 3 4", obs)).toEqual({ kind: "action", action: { type: "strikeSubset", targets: [0, 2, 3] } });
    expect(parse("strike 6", obs)).toEqual({ kind: "action", action: { type: "strikeSubset", targets: [5] } });
  });

  it("strikes nothing on request", () => {
    expect(parse("strike none", obs)).toEqual({ kind: "action", action: { type: "strikeSubset", targets: [] } });
  });

  it("strikes everything any structure flagged, or only what two or more agree on", () => {
    expect(parse("strike flagged", obs)).toMatchObject({ action: { targets: [0, 2, 4, 5] } });
    expect(parse("strike confirmed", obs)).toMatchObject({ action: { targets: [2, 4] } });
  });

  it("refuses 'confirmed' when no target is flagged twice", () => {
    expect(errorOf(parse("strike confirmed", presence([101], [102])))).toMatch(/No target is flagged by two structures/);
    expect(errorOf(parse("strike flagged", presence([], [])))).toMatch(/No structure has flagged/);
  });

  it("explains a mistake", () => {
    expect(errorOf(parse("strike", obs))).toMatch(/Choose targets by number/);
    expect(errorOf(parse("strike 0", obs))).toMatch(/Target 0 does not exist \(targets are numbered 1 to 6\)/);
    expect(errorOf(parse("strike 7", obs))).toMatch(/Target 7 does not exist/);
    expect(errorOf(parse("strike 2 2", obs))).toMatch(/Target 2 was listed twice/);
    expect(errorOf(parse("strike high", obs))).toMatch(/Choose targets by number/);
    expect(errorOf(parse("strike 1 x", obs))).toMatch(/Choose targets by number/);
  });
});

describe("unknown commands", () => {
  it("suggests the closest command for a typo", () => {
    expect(errorOf(parse("deplooy bloom 1024"))).toMatch(/Did you mean "deploy"/);
    expect(errorOf(parse("stike 5"))).toMatch(/Did you mean "strike"/);
  });

  it("points to help when nothing is close", () => {
    expect(errorOf(parse("xyzzy"))).toMatch(/Type "help"/);
  });
});
