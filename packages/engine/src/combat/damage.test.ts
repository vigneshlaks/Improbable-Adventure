import { describe, expect, it } from "vitest";
import { countStrike, frequencyStrike, presenceStrike, type DamageRules } from "./damage";

const RULES: DamageRules = {
  base: 20,
  hitDamage: 5,
  decoyPenalty: 4,
  blockPenalty: 3,
  missPenalty: 3,
  overshootExp: 2,
  countTol: 0.25,
};

describe("frequencyStrike", () => {
  it("blocks a force below the true count and charges the block penalty", () => {
    expect(frequencyStrike(RULES, 88, 87)).toEqual({ kind: "frequency", outcome: "blocked", damage: 0, certaintyLost: 3, force: 87, trueCount: 88 });
    expect(frequencyStrike(RULES, 88, 0)).toMatchObject({ outcome: "blocked" });
  });

  it("deals full BASE at exactly the true count", () => {
    expect(frequencyStrike(RULES, 88, 88)).toEqual({ kind: "frequency", outcome: "hit", damage: 20, certaintyLost: 0, force: 88, trueCount: 88 });
  });

  it("wastes force when overshooting: BASE x (f / s)^OVERSHOOT_EXP", () => {
    expect(frequencyStrike(RULES, 100, 200).damage).toBe(5); // (1/2)^2 x 20
    expect(frequencyStrike(RULES, 100, 150).damage).toBeCloseTo(20 * (100 / 150) ** 2, 5);
    expect(frequencyStrike(RULES, 100, 1000).damage).toBeCloseTo(0.2, 5);
  });

  it("never increases damage as the force grows past the count", () => {
    let previous = Infinity;
    for (let s = 100; s <= 400; s += 7) {
      const { damage } = frequencyStrike(RULES, 100, s);
      expect(damage).toBeLessThanOrEqual(previous);
      previous = damage;
    }
  });

  it("supports a non-integer exponent", () => {
    const rules = { ...RULES, overshootExp: 1.5 };
    expect(frequencyStrike(rules, 100, 200).damage).toBeCloseTo(20 * 0.5 ** 1.5, 5);
  });

  it("rounds damage to a fixed precision so results do not depend on the last digit", () => {
    const { damage } = frequencyStrike(RULES, 100, 137);
    expect(damage).toBe(Math.round(damage * 1e6) / 1e6);
  });

  it("rejects a force that is not a finite non-negative number", () => {
    expect(() => frequencyStrike(RULES, 10, -1)).toThrow(RangeError);
    expect(() => frequencyStrike(RULES, 10, NaN)).toThrow(RangeError);
    expect(() => frequencyStrike(RULES, 10, Infinity)).toThrow(RangeError);
  });
});

describe("countStrike", () => {
  // The tolerance band is COUNT_TOL x D = 0.25 x 200 = 50.
  it("deals full BASE for an exact estimate", () => {
    expect(countStrike(RULES, 200, 200)).toMatchObject({ outcome: "hit", damage: 20, certaintyLost: 0, accuracy: 1 });
    expect(countStrike(RULES, 200, 175)).toMatchObject({ estimate: 175, trueDistinct: 200 }); // the player is shown what was true
    expect(countStrike(RULES, 200, 400)).toMatchObject({ outcome: "miss", estimate: 400, trueDistinct: 200 });
  });

  it("falls off linearly across the tolerance band, in both directions", () => {
    expect(countStrike(RULES, 200, 225).damage).toBe(10); // halfway across the band
    expect(countStrike(RULES, 200, 175).damage).toBe(10);
    expect(countStrike(RULES, 200, 210).damage).toBe(16);
  });

  it("deals nothing at the edge of the band and charges nothing", () => {
    expect(countStrike(RULES, 200, 250)).toMatchObject({ outcome: "hit", damage: 0, certaintyLost: 0 });
    expect(countStrike(RULES, 200, 150)).toMatchObject({ damage: 0, certaintyLost: 0 });
  });

  it("charges the miss penalty beyond the band", () => {
    expect(countStrike(RULES, 200, 251)).toMatchObject({ outcome: "miss", damage: 0, certaintyLost: 3 });
    expect(countStrike(RULES, 200, 0)).toMatchObject({ outcome: "miss", certaintyLost: 3 });
  });

  it("handles a stream with nothing live", () => {
    expect(countStrike(RULES, 0, 0)).toMatchObject({ outcome: "hit", damage: 20 });
    expect(countStrike(RULES, 0, 1)).toMatchObject({ outcome: "miss", certaintyLost: 3 });
  });

  it("rejects an estimate that is not a finite non-negative number", () => {
    expect(() => countStrike(RULES, 10, -5)).toThrow(RangeError);
    expect(() => countStrike(RULES, 10, NaN)).toThrow(RangeError);
  });
});

describe("presenceStrike", () => {
  const real = [true, false, true, true, false, false]; // targets 0, 2, 3 are real

  it("pays HIT_DAMAGE per real target and charges DECOY_PENALTY per decoy", () => {
    expect(presenceStrike(RULES, real, [0, 2, 3])).toEqual({ kind: "presence", realHits: 3, decoyHits: 0, damage: 15, certaintyLost: 0, realTotal: 3 });
    expect(presenceStrike(RULES, real, [0, 1])).toEqual({ kind: "presence", realHits: 1, decoyHits: 1, damage: 5, certaintyLost: 4, realTotal: 3 }); // 2 real targets were left
    expect(presenceStrike(RULES, real, [1, 4, 5])).toMatchObject({ realHits: 0, decoyHits: 3, damage: 0, certaintyLost: 12 });
  });

  it("allows striking nothing", () => {
    expect(presenceStrike(RULES, real, [])).toMatchObject({ damage: 0, certaintyLost: 0 });
  });

  it("rejects duplicates, out-of-range and non-integer targets", () => {
    expect(() => presenceStrike(RULES, real, [0, 0])).toThrow(RangeError);
    expect(() => presenceStrike(RULES, real, [6])).toThrow(RangeError);
    expect(() => presenceStrike(RULES, real, [-1])).toThrow(RangeError);
    expect(() => presenceStrike(RULES, real, [1.5])).toThrow(RangeError);
  });
});
