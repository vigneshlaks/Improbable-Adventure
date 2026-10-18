import { describe, expect, it } from "vitest";
import { structureConstants } from "@pda/content";
import { BloomFilter, HyperLogLog, Rng } from "@pda/engine";
import { sizeBloom, sizeCountMin, sizeHyperLogLog, sizeLinearCounting, sizeReservoir, sizeExact, sizingConstants } from "./sizing";

const constants = sizingConstants(structureConstants());

describe("sizing", () => {
  it("solves each structure from error, from memory, or from both, and reports whether the target is met", () => {
    // Bloom: 1,000 items at 1% needs about 9,586 bits and 7 hashes.
    const bloom = sizeBloom({ items: 1000, error: 0.01 }, constants);
    expect(bloom.bits).toBeGreaterThanOrEqual(9586);
    expect(bloom.bits).toBeLessThan(9650);
    expect(bloom.hashes).toBe(7);
    expect(bloom.falsePositiveRate).toBeLessThanOrEqual(0.01);
    // Memory alone: the rate follows from the bits.
    const tight = sizeBloom({ items: 1000, memoryBits: 4793 }, constants);
    expect(tight.falsePositiveRate).toBeCloseTo(0.1, 1);
    // Both: the memory is used, and the target is reported as missed.
    expect(sizeBloom({ items: 1000, error: 0.01, memoryBits: 4793 }, constants).meetsTarget).toBe(false);
    expect(sizeBloom({ items: 1000, error: 0.01, memoryBits: 20000 }, constants).meetsTarget).toBe(true);

    // Count-Min: width e / epsilon, depth ln(1 / (1 - confidence)).
    const cms = sizeCountMin({ items: 100000, error: 0.01 }, constants);
    expect(cms.width).toBe(272);
    expect(cms.depth).toBe(3);
    expect(cms.memoryBits).toBe(272 * 3 * 32);
    expect(cms.overshoot).toBeCloseTo(0.01 * 100000, -1);

    // HyperLogLog: a power-of-two register count, error 1.04 / sqrt(registers).
    const hll = sizeHyperLogLog({ distinct: 1e6, error: 0.02 }, constants);
    expect(hll.registers).toBe(4096);
    expect(hll.standardError).toBeCloseTo(1.04 / 64, 6);
    expect(hll.memoryBits).toBe(4096 * 5);
    expect(sizeHyperLogLog({ distinct: 1e6, memoryBits: 5 * 1024 }, constants).registers).toBe(1024);

    // Linear Counting: the smallest bit array whose standard error is within the target.
    const linear = sizeLinearCounting({ distinct: 10000, error: 0.01 }, constants);
    expect(linear.standardError).toBeLessThanOrEqual(0.01);
    expect(sizeLinearCounting({ distinct: 10000, memoryBits: linear.bits - 1 }, constants).standardError).toBeGreaterThan(0.01 * 0.99);

    // Reservoir: sample size for a proportion within the error at the confidence; Exact: every value and its counter.
    expect(sizeReservoir({ error: 0.05 }, constants).sampleSize).toBe(385);
    expect(sizeExact({ distinct: 1000 }, constants).memoryBits).toBe(1000 * (constants.valueBits + 32));

    // Blank everything: a default target is used, and a missing size that is needed is refused.
    expect(sizeBloom({ items: 1000 }, constants).bits).toBeGreaterThan(0);
    expect(() => sizeBloom({ error: 0.01 }, constants)).toThrow(RangeError);
    expect(() => sizeHyperLogLog({ distinct: 100, error: 0 }, constants)).toThrow(RangeError);
  });

  describe("statistical (300 seeded trials)", () => {
    const TRIALS = 300;
    // Three standard deviations of chance below the stated confidence.
    const floor = (confidence: number) => confidence - 3 * Math.sqrt((confidence * (1 - confidence)) / TRIALS);

    it("a Bloom Filter sized for 1% flags decoys at about that rate, and no more than 1.3 times it", () => {
      const sized = sizeBloom({ items: 1000, error: 0.01 }, constants);
      let flagged = 0;
      let probes = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = Rng.fromSeed(`size-bloom-${t}`);
        const filter = new BloomFilter({ spaceBits: sized.bits, knob: 1000 }, constants);
        for (let i = 0; i < 1000; i++) filter.ingest({ op: "insert", value: rng.next() });
        for (let i = 0; i < 200; i++) {
          const answer = filter.query({ kind: "presence", targets: [rng.next()] });
          flagged += (answer?.estimate as number[]).length;
          probes++;
        }
      }
      expect(flagged / probes).toBeLessThanOrEqual(0.01 * 1.3);
    });

    it("a HyperLogLog sized for 2% lands within two standard errors for the stated share of streams", () => {
      const sized = sizeHyperLogLog({ distinct: 20000, error: 0.02 }, constants);
      let inside = 0;
      for (let t = 0; t < TRIALS; t++) {
        const rng = Rng.fromSeed(`size-hll-${t}`);
        const hll = new HyperLogLog({ spaceBits: sized.memoryBits }, constants);
        for (let i = 0; i < 20000; i++) hll.ingest({ op: "insert", value: rng.next() });
        const estimate = (hll.query({ kind: "count" })?.estimate as number) ?? 0;
        if (Math.abs(estimate - 20000) / 20000 <= 1.96 * sized.standardError) inside++;
      }
      expect(inside / TRIALS).toBeGreaterThanOrEqual(floor(0.95));
    });
  });
});
