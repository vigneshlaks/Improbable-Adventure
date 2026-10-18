import { BloomFilter, CountMinSketch, HyperLogLog, LinearCounting, LogLog, murmur3String, murmur3U32, doubleHashIndices, PUBLIC_HASH_SEED, type StructureConstants } from "@pda/engine";
import { sizeBloom, sizeCountMin, sizeExact, sizeHyperLogLog, sizeLinearCounting, sizeLogLog, sizeReservoir, sizingConstants } from "./sizing";

/** The i-th value of the fixed test stream every language's tests replay: spread across the 32-bit range. */
export const stream = (i: number): number => Math.imul(i + 1, 2654435761) >>> 0;

/**
 * The known answers shipped with every toolkit as `tests/vectors.json`. They come from the game's own structures
 * and the exporter's own sizing, so a toolkit that matches them behaves as the game's structures do.
 */
export function buildVectors(constants: StructureConstants): Record<string, unknown> {
  const sc = sizingConstants(constants);

  const hash = [
    ...[0, 1, 42, 4294967295].flatMap((item) => [0, PUBLIC_HASH_SEED].map((seed) => ({ item, seed, hash: murmur3U32(item, seed) }))),
    ...["", "a", "hello", "héllo", "probabilistic data adventure"].flatMap((item) => [0, PUBLIC_HASH_SEED].map((seed) => ({ item, seed, hash: murmur3String(item, seed) }))),
  ];
  const positions = [
    { item: 42, k: 7, modulus: 1000, seed: PUBLIC_HASH_SEED },
    { item: 4294967295, k: 5, modulus: 65537, seed: 0 },
    { item: stream(3), k: 4, modulus: 13, seed: PUBLIC_HASH_SEED },
  ].map((c) => ({ ...c, positions: doubleHashIndices(c.item, c.k, c.modulus, c.seed) }));

  const bloomBits = 2048;
  const bloomItems = 300;
  const bloom = new BloomFilter({ spaceBits: bloomBits, knob: 237 }, constants);
  if (bloom.params.k !== 6) throw new Error("The Bloom vector expects 6 hashes");
  for (let i = 0; i < bloomItems; i++) bloom.ingest({ op: "insert", value: stream(i) });
  const probes = Array.from({ length: 40 }, (_, i) => (bloom.query({ kind: "presence", targets: [stream(bloomItems + i)] })?.estimate as number[]).length === 1);

  const cmsWidth = 64;
  const cmsDepth = 4;
  const cmsDistinct = 50;
  const cmsEvents = 2000;
  const cms = new CountMinSketch({ spaceBits: 32 * cmsWidth * cmsDepth, knob: cmsDepth }, constants);
  for (let i = 0; i < cmsEvents; i++) cms.ingest({ op: "insert", value: stream(i % cmsDistinct) });

  const registers = (kind: "hyperLogLog" | "logLog", indexBits: number, items: number) => {
    const counter = kind === "hyperLogLog" ? new HyperLogLog({ spaceBits: 5 * 2 ** indexBits }, constants) : new LogLog({ spaceBits: 5 * 2 ** indexBits }, constants);
    for (let i = 0; i < items; i++) counter.ingest({ op: "insert", value: stream(i) });
    return { indexBits, items, estimate: counter.estimate() };
  };

  const linear = new LinearCounting({ spaceBits: 4096 }, constants);
  for (let i = 0; i < 1000; i++) linear.ingest({ op: "insert", value: stream(i) });

  const sizingCases = [
    { fn: "sizeBloom", input: { items: 1000, error: 0.01 }, output: sizeBloom({ items: 1000, error: 0.01 }, sc) },
    { fn: "sizeBloom", input: { items: 1000, memoryBits: 4793 }, output: sizeBloom({ items: 1000, memoryBits: 4793 }, sc) },
    { fn: "sizeBloom", input: { items: 50000, error: 0.001, memoryBits: 200000 }, output: sizeBloom({ items: 50000, error: 0.001, memoryBits: 200000 }, sc) },
    { fn: "sizeCountMin", input: { items: 100000, error: 0.01 }, output: sizeCountMin({ items: 100000, error: 0.01 }, sc) },
    { fn: "sizeCountMin", input: { items: 5000, memoryBits: 40000 }, output: sizeCountMin({ items: 5000, memoryBits: 40000 }, sc) },
    { fn: "sizeHyperLogLog", input: { distinct: 1e6, error: 0.02 }, output: sizeHyperLogLog({ distinct: 1e6, error: 0.02 }, sc) },
    { fn: "sizeHyperLogLog", input: { memoryBits: 5000 }, output: sizeHyperLogLog({ memoryBits: 5000 }, sc) },
    { fn: "sizeHyperLogLog", input: { error: 0.5 }, output: sizeHyperLogLog({ error: 0.5 }, sc) },
    { fn: "sizeLogLog", input: { distinct: 1e6, error: 0.05 }, output: sizeLogLog({ distinct: 1e6, error: 0.05 }, sc) },
    { fn: "sizeLinearCounting", input: { distinct: 10000, error: 0.01 }, output: sizeLinearCounting({ distinct: 10000, error: 0.01 }, sc) },
    { fn: "sizeLinearCounting", input: { distinct: 10000, memoryBits: 8000 }, output: sizeLinearCounting({ distinct: 10000, memoryBits: 8000 }, sc) },
    { fn: "sizeReservoir", input: { error: 0.05 }, output: sizeReservoir({ error: 0.05 }, sc) },
    { fn: "sizeReservoir", input: { memoryBits: 3200 }, output: sizeReservoir({ memoryBits: 3200 }, sc) },
    { fn: "sizeExact", input: { distinct: 1000, memoryBits: 10000 }, output: sizeExact({ distinct: 1000, memoryBits: 10000 }, sc) },
  ];

  return {
    note: "Known answers produced by the reference implementation. The i-th test stream value is (i + 1) * 2654435761 mod 2^32.",
    hash,
    positions,
    bloom: { bits: bloomBits, hashes: 6, items: bloomItems, fill: bloom.fill, probes },
    countMin: { width: cmsWidth, depth: cmsDepth, distinct: cmsDistinct, events: cmsEvents, estimates: Array.from({ length: 10 }, (_, i) => cms.estimate(stream(i))) },
    hyperLogLog: [registers("hyperLogLog", 8, 100), registers("hyperLogLog", 8, 5000), registers("hyperLogLog", 10, 100000)],
    logLog: [registers("logLog", 10, 50000), registers("logLog", 12, 200000)],
    linearCounting: { bits: 4096, items: 1000, estimate: linear.query({ kind: "count" })?.estimate },
    sizing: sizingCases,
  };
}
