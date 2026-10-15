import { describe, expect, it } from "vitest";
import balanceJson from "../balance.json";
// The engine's tests use their own stand-in constants; this test keeps that stand-in in sync with balance.json.
import { TEST_CONSTANTS } from "../../engine/src/structures/testUtils";
import { balance, parseBalance, structureConstants } from "./balance";
import { structures } from "./structures";

describe("the starting loadout", () => {
  const owned = balance.STARTING_LOADOUT.map((kind) => structures[kind]);

  it("owns more structures than it has slots, so every fight asks the player to choose", () => {
    expect(balance.STARTING_LOADOUT.length).toBeGreaterThan(balance.STARTING_SLOTS);
  });

  it("has a structure built for Count, because Exact Memory fills up and the others cannot count well", () => {
    expect(owned.some((info) => info.answers.length === 1 && info.answers[0] === "count")).toBe(true);
  });
});

describe("balance.json", () => {
  it("validates and carries the spec's starting values", () => {
    expect(balance).toMatchObject({
      BASE: 20,
      HIT_DAMAGE: 5,
      DECOY_PENALTY: 4,
      BLOCK_PENALTY: 3,
      MISS_PENALTY: 3,
      OVERSHOOT_EXP: 2,
      COUNT_TOL: 0.25,
      RANK_TOL: 0.1,
      STARTING_SPACE: 8192,
      STARTING_CERTAINTY: 100,
      STARTING_SLOTS: 3,
      REST_HEAL: 30,
      VALUE_BITS: 32,
      LIKE_THRESHOLD: 0.6,
      CUNNING_SEARCH: 50000,
    });
  });

  it("carries the fight settings the engine needs", () => {
    expect(balance.EXPECTED_TURNS).toBe(5);
    expect(balance.STARTING_LOADOUT).toEqual(["exactMemory", "reservoirSampling", "bloomFilter", "linearCounting"]);
    expect(Object.keys(balance.TIERS)).toEqual(["minion", "elite", "boss"]);
  });

  it("makes tiers harder as they go up", () => {
    const { minion, elite, boss } = balance.TIERS;
    for (const field of ["size", "hp", "attack", "highChance"] as const) {
      expect(minion[field]).toBeLessThan(elite[field]);
      expect(elite[field]).toBeLessThan(boss[field]);
    }
    expect(minion.traitCount.max).toBeLessThanOrEqual(2); // the spec's Minions have 1 or 2 non-Low traits
    expect(elite.traitCount).toEqual({ min: 3, max: 3 });
    expect(boss.traitCount.min).toBe(4);
    expect(boss.weakPointCount).toEqual({ min: 2, max: 2 });
  });

  it("rejects missing, unknown and out-of-range values", () => {
    const { BASE: _omitted, ...missing } = balanceJson;
    void _omitted;
    expect(() => parseBalance(missing)).toThrow();
    expect(() => parseBalance({ ...balanceJson, EXTRA: 1 })).toThrow();
    expect(() => parseBalance({ ...balanceJson, CONFIDENCE: 1.5 })).toThrow();
    expect(() => parseBalance({ ...balanceJson, VALUE_BITS: 0 })).toThrow();
    expect(() => parseBalance({ ...balanceJson, STARTING_LOADOUT: ["skipList"] })).toThrow();
    expect(() => parseBalance({ ...balanceJson, TIERS: { ...balanceJson.TIERS, minion: { ...balanceJson.TIERS.minion, hp: 0 } } })).toThrow();
    expect(() => parseBalance({ ...balanceJson, TIERS: { ...balanceJson.TIERS, minion: { ...balanceJson.TIERS.minion, traitCount: { min: 3, max: 1 } } } })).toThrow();
  });

  it("feeds the engine its structure constants", () => {
    expect(structureConstants()).toEqual({
      valueBits: 32,
      confidence: 0.95,
      cmsDefaultDepth: 4,
      logLogErrorCoefficient: 1.3,
    });
  });

  it("matches the stand-in constants used by the engine's tests", () => {
    expect(TEST_CONSTANTS).toEqual(structureConstants());
  });
});
