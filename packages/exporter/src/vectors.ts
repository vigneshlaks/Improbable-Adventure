import { BloomFilter, CountMinSketch, CountSketch, CuckooFilter, DyadicCountMin, HyperLogLog, KllSketch, kllCapacity, KMinimumValues, TDigest, TopKTracker, LinearCounting, LogLog, MinHash, QuotientFilter, SimHash, SpectralBloom, murmur3String, murmur3U32, doubleHashIndices, PUBLIC_HASH_SEED, type StructureConstants } from "@pda/engine";
import { sizeBloom, sizeCountMin, sizeCountSketch, sizeCuckoo, sizeDyadic, sizeExact, sizeHyperLogLog, sizeKll, sizeKmv, sizeTDigest, sizeTopK, sizeLinearCounting, sizeLogLog, sizeMinHash, sizeQuotient, sizeReservoir, sizeScalable, sizeSimHash, sizeSpectral, sizingConstants } from "./sizing";

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

  const csWidth = 64;
  const csDepth = 5;
  const countSketch = new CountSketch({ spaceBits: 32 * csWidth * csDepth, knob: csDepth }, constants);
  for (let i = 0; i < cmsEvents; i++) countSketch.ingest({ op: "insert", value: stream(i % cmsDistinct) });
  for (let i = 0; i < 300; i++) countSketch.ingest({ op: "delete", value: stream(i % 7) });

  const cuckooBuckets = 128;
  const cuckooBits = 8;
  const cuckooItems = 300;
  const cuckoo = new CuckooFilter({ spaceBits: cuckooBuckets * 4 * cuckooBits, knob: cuckooBits }, constants);
  for (let i = 0; i < cuckooItems; i++) cuckoo.ingest({ op: "insert", value: stream(i) });
  for (let i = 0; i < 60; i++) cuckoo.ingest({ op: "delete", value: stream(i * 5) });
  const has = (value: number) => (cuckoo.query({ kind: "presence", targets: [value] })?.estimate as number[]).length === 1;

  const kmvK = 64;
  const kmv = new KMinimumValues({ spaceBits: 32 * kmvK }, constants);
  for (let i = 0; i < 1000; i++) kmv.ingest({ op: "insert", value: stream(i) });
  const kmvSmall = new KMinimumValues({ spaceBits: 32 * kmvK }, constants);
  for (let i = 0; i < 40; i++) kmvSmall.ingest({ op: "insert", value: stream(i) });
  const kmvOther = new KMinimumValues({ spaceBits: 32 * kmvK }, constants);
  for (let i = 600; i < 1800; i++) kmvOther.ingest({ op: "insert", value: stream(i) });

  const minK = 64;
  const left = new MinHash({ spaceBits: 32 * minK }, constants);
  const right = new MinHash({ spaceBits: 32 * minK }, constants);
  for (let i = 0; i < 300; i++) left.ingest({ op: "insert", value: stream(i) });
  for (let i = 150; i < 450; i++) right.ingest({ op: "insert", value: stream(i) });

  const quotientQ = 9;
  const quotientR = 8;
  const quotient = new QuotientFilter({ spaceBits: 2 ** quotientQ * (quotientR + 3), knob: quotientR }, constants);
  const quotientOther = new QuotientFilter({ spaceBits: 2 ** quotientQ * (quotientR + 3), knob: quotientR }, constants);
  if (quotient.params.quotientBits !== quotientQ) throw new Error("The Quotient vector expects 9 quotient bits");
  for (let i = 0; i < 300; i++) quotient.ingest({ op: "insert", value: stream(i) });
  for (let i = 0; i < 40; i++) quotient.ingest({ op: "delete", value: stream(i * 3) });
  for (let i = 200; i < 420; i++) quotientOther.ingest({ op: "insert", value: stream(i) });
  const quotientHas = (filter: QuotientFilter, value: number) => (filter.query({ kind: "presence", targets: [value] })?.estimate as number[]).length === 1;
  const quotientMerged = quotient.merge(quotientOther) as QuotientFilter;

  const spectralCounters = 512;
  const spectral = new SpectralBloom({ spaceBits: 16 * spectralCounters, knob: 90 }, constants);
  for (let i = 0; i < 1000; i++) spectral.ingest({ op: "insert", value: stream(i % 50) });
  for (let i = 0; i < 100; i++) spectral.ingest({ op: "delete", value: stream(i % 5) });
  const spectralHas = (value: number) => (spectral.query({ kind: "presence", targets: [value] })?.estimate as number[]).length === 1;

  const simPlanes = 256;
  const sim = new SimHash({ spaceBits: 16 * simPlanes }, constants);
  for (let i = 0; i < 300; i++) sim.ingest({ op: "insert", value: stream(i) });
  const simRepeats = new SimHash({ spaceBits: 16 * simPlanes }, constants);
  for (let i = 0; i < 300; i++) simRepeats.ingest({ op: "insert", value: stream(i < 150 ? 0 : i) });
  const simCopy = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => stream(from + i));
  const simCases = [
    { from: 0, to: 300 },
    { from: 150, to: 450 },
    { from: 1000, to: 1300 },
    { from: 0, to: 120 },
  ].map((c) => ({ ...c, differing: sim.differing(simCopy(c.from, c.to)), similarity: SimHash.similarityAt(sim.differing(simCopy(c.from, c.to)), sim.effectiveSize(), c.to - c.from) }));

  const kllK = 40;
  const kll = new KllSketch({ spaceBits: 32 * kllCapacity(kllK, 24) }, constants);
  if (kll.params.k !== kllK) throw new Error("The KLL vector expects k of 40");
  const kllValues = Array.from({ length: 20000 }, (_, i) => stream(i));
  for (const value of kllValues) kll.ingest({ op: "insert", value });
  const kllQuantiles = [0.01, 0.1, 0.5, 0.9, 0.99];
  const kllProbes = [stream(3), stream(77), stream(1234), stream(19999)];
  const kllItems = kll.items;
  const kllTotal = kllItems.reduce((sum, item) => sum + item.weight, 0);

  const digestCompression = 64;
  const digest = new TDigest({ spaceBits: 64 * digestCompression }, constants);
  for (let i = 0; i < 5000; i++) digest.ingest({ op: "insert", value: stream(i) });
  const digestQuantiles = [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999];

  const dyadic = new DyadicCountMin({ spaceBits: 8192, knob: 3 }, constants);
  for (let i = 0; i < 900; i++) dyadic.ingest({ op: "insert", value: stream(i) });
  for (let i = 0; i < 100; i++) dyadic.ingest({ op: "delete", value: stream(i) });
  const dyadicQuantiles = [0.1, 0.3, 0.5, 0.9, 0.99].map((quantile) => {
    const answer = dyadic.query({ kind: "rank", quantile }) as { estimate: number; low: number; high: number };
    return { quantile, estimate: answer.estimate, low: answer.low, high: Number.isFinite(answer.high) ? answer.high : null };
  });

  const topKSpace = 12288;
  const topK = new TopKTracker({ spaceBits: topKSpace, knob: 4 }, constants);
  const topKValue = (i: number) => stream(Math.floor(60 * (((i * 7919) % 1000) / 1000) ** 2));
  for (let i = 0; i < 3000; i++) topK.ingest({ op: "insert", value: topKValue(i) });
  for (let i = 0; i < 200; i++) topK.ingest({ op: "delete", value: topKValue(i * 3) });
  const topKAnswer = (value: number) => topK.query({ kind: "frequency", value }) as { low: number; high: number };

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
    { fn: "sizeCountSketch", input: { error: 0.1 }, output: sizeCountSketch({ error: 0.1 }, sc) },
    { fn: "sizeCountSketch", input: { memoryBits: 100000 }, output: sizeCountSketch({ memoryBits: 100000 }, sc) },
    { fn: "sizeCuckoo", input: { items: 100000, error: 0.01 }, output: sizeCuckoo({ items: 100000, error: 0.01 }, sc) },
    { fn: "sizeCuckoo", input: { items: 5000, memoryBits: 60000 }, output: sizeCuckoo({ items: 5000, memoryBits: 60000 }, sc) },
    { fn: "sizeKmv", input: { error: 0.02 }, output: sizeKmv({ error: 0.02 }, sc) },
    { fn: "sizeKmv", input: { memoryBits: 8192 }, output: sizeKmv({ memoryBits: 8192 }, sc) },
    { fn: "sizeMinHash", input: { error: 0.02 }, output: sizeMinHash({ error: 0.02 }, sc) },
    { fn: "sizeMinHash", input: { memoryBits: 4096 }, output: sizeMinHash({ memoryBits: 4096 }, sc) },
    { fn: "sizeQuotient", input: { items: 50000, error: 0.01 }, output: sizeQuotient({ items: 50000, error: 0.01 }, sc) },
    { fn: "sizeQuotient", input: { items: 1000, memoryBits: 20000 }, output: sizeQuotient({ items: 1000, memoryBits: 20000 }, sc) },
    { fn: "sizeSpectral", input: { items: 10000, error: 0.01 }, output: sizeSpectral({ items: 10000, error: 0.01 }, sc) },
    { fn: "sizeSpectral", input: { items: 1000, memoryBits: 24000 }, output: sizeSpectral({ items: 1000, memoryBits: 24000 }, sc) },
    { fn: "sizeScalable", input: { items: 100000, error: 0.01 }, output: sizeScalable({ items: 100000, error: 0.01 }, sc) },
    { fn: "sizeScalable", input: { items: 500, error: 0.05, memoryBits: 1000 }, output: sizeScalable({ items: 500, error: 0.05, memoryBits: 1000 }, sc) },
    { fn: "sizeSimHash", input: { error: 0.03 }, output: sizeSimHash({ error: 0.03 }, sc) },
    { fn: "sizeSimHash", input: { memoryBits: 8192 }, output: sizeSimHash({ memoryBits: 8192 }, sc) },
    { fn: "sizeKll", input: { error: 0.01 }, output: sizeKll({ error: 0.01 }, sc) },
    { fn: "sizeKll", input: { memoryBits: 20000 }, output: sizeKll({ memoryBits: 20000 }, sc) },
    { fn: "sizeTDigest", input: { error: 0.01 }, output: sizeTDigest({ error: 0.01 }, sc) },
    { fn: "sizeTDigest", input: { memoryBits: 10000 }, output: sizeTDigest({ memoryBits: 10000 }, sc) },
    { fn: "sizeDyadic", input: { error: 0.05 }, output: sizeDyadic({ error: 0.05 }, sc) },
    { fn: "sizeDyadic", input: { memoryBits: 10000000 }, output: sizeDyadic({ memoryBits: 10000000 }, sc) },
    { fn: "sizeTopK", input: { error: 0.01 }, output: sizeTopK({ error: 0.01 }, sc) },
    { fn: "sizeTopK", input: { memoryBits: 30000 }, output: sizeTopK({ memoryBits: 30000 }, sc) },
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
    countSketch: { width: csWidth, depth: csDepth, distinct: cmsDistinct, events: cmsEvents, removed: 300, estimates: Array.from({ length: 10 }, (_, i) => countSketch.rawEstimate(stream(i))), squaredNorm: countSketch.squaredNorm },
    cuckoo: { buckets: cuckooBuckets, fingerprintBits: cuckooBits, items: cuckooItems, removed: 60, size: cuckoo.size, present: Array.from({ length: 80 }, (_, i) => has(stream(i * 5 + (i % 5)))), outside: Array.from({ length: 60 }, (_, i) => has(stream(cuckooItems + i))) },
    kmv: { k: kmvK, items: 1000, count: kmv.query({ kind: "count" })?.estimate, hashes: kmv.hashes.slice(0, 6), small: { items: 40, count: kmvSmall.query({ kind: "count" })?.estimate }, mergedWith: { from: 600, to: 1800, count: kmv.merge(kmvOther).query({ kind: "count" })?.estimate } },
    minHash: { k: minK, left: { from: 0, to: 300 }, right: { from: 150, to: 450 }, signature: left.signature.slice(0, 8), similarity: minHashSimilarity(left, right), merged: left.merge(right).signature.slice(0, 8) },
    quotient: {
      quotientBits: quotientQ,
      remainderBits: quotientR,
      items: 300,
      removed: 40,
      size: quotient.size,
      falsePositiveRate: quotient.falsePositiveRate(),
      present: Array.from({ length: 90 }, (_, i) => quotientHas(quotient, stream(i * 4 + (i % 4)))),
      outside: Array.from({ length: 60 }, (_, i) => quotientHas(quotient, stream(300 + i))),
      merged: { from: 200, to: 420, size: quotientMerged.size, lost: quotientMerged.lost, probes: Array.from({ length: 60 }, (_, i) => quotientHas(quotientMerged, stream(150 + i * 8))) },
    },
    spectral: {
      counters: spectralCounters,
      hashes: spectral.params.k,
      distinct: 50,
      events: 1000,
      removed: 100,
      estimates: Array.from({ length: 10 }, (_, i) => spectral.estimate(stream(i))),
      present: Array.from({ length: 40 }, (_, i) => spectralHas(stream(i + 30))),
      overshoot: spectral.errorBand,
      falsePositiveRate: spectral.falsePositiveRate,
    },
    simHash: { planes: simPlanes, items: 300, effectiveSize: sim.effectiveSize(), repeatsEffectiveSize: simRepeats.effectiveSize(), cases: simCases },
    kll: {
      k: kllK,
      items: 20000,
      quantiles: kllQuantiles.map((quantile) => ({ quantile, value: kll.quantile(quantile) })),
      ranks: kllProbes.map((value) => ({ value, rank: kllItems.filter((item) => item.value <= value).reduce((sum, item) => sum + item.weight, 0) / kllTotal })),
      stored: kllItems.length,
    },
    tDigest: { compression: digestCompression, items: 5000, centroids: digest.summary.length, quantiles: digestQuantiles.map((quantile) => ({ quantile, value: digest.query({ kind: "rank", quantile })?.estimate })) },
    dyadic: { bits: 8, width: dyadic.params.width, depth: dyadic.params.depth, items: 900, removed: 100, quantiles: dyadicQuantiles },
    topK: {
      width: topK.params.width,
      depth: topK.params.depth,
      capacity: topK.params.candidates,
      candidates: topK.candidates.slice(0, 8).map((c) => ({ item: c.value, low: c.low, high: c.high })),
      estimates: Array.from({ length: 12 }, (_, i) => ({ item: stream(i * 5), ...topKAnswer(stream(i * 5)) })),
    },
    sizing: sizingCases,
  };
}

/** The share of slots whose minima agree (what the toolkit's `similarity` returns), read off two engine MinHashes. */
function minHashSimilarity(a: MinHash, b: MinHash): number {
  const x = a.signature;
  const y = b.signature;
  let agree = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === y[i] && x[i] !== 2 ** 32) agree++;
  return agree / x.length;
}
