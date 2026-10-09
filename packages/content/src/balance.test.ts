import { describe, expect, it } from "vitest";
import balanceJson from "../balance.json";
import { balance, parseBalance, structureConstants } from "./balance";

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

  it("rejects missing, unknown and out-of-range values", () => {
    const { BASE: _omitted, ...missing } = balanceJson;
    void _omitted;
    expect(() => parseBalance(missing)).toThrow();
    expect(() => parseBalance({ ...balanceJson, EXTRA: 1 })).toThrow();
    expect(() => parseBalance({ ...balanceJson, CONFIDENCE: 1.5 })).toThrow();
    expect(() => parseBalance({ ...balanceJson, VALUE_BITS: 0 })).toThrow();
  });

  it("feeds the engine its structure constants", () => {
    expect(structureConstants()).toEqual({ valueBits: 32, confidence: 0.95 });
  });
});
