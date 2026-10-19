import { balance } from "@pda/content";
import { COUNTER_BITS, LOGLOG_REGISTER_BITS, type StructureConstants } from "@pda/engine";

/**
 * Real-world sizing, as opposed to the game's deliberately tight Space. Every function takes the player's workload
 * (any field may be blank) and returns parameters, the error they give and the memory they take. Given a target error
 * the memory is solved for; given a memory budget the error is; given both, the memory is used and `meetsTarget` says
 * whether the error was reached; given neither, the default target is used.
 */
export interface SizingConstants extends StructureConstants {
  counterBits: number;
  registerBits: number;
  defaultError: number;
}

export function sizingConstants(constants: StructureConstants): SizingConstants {
  return { ...constants, counterBits: COUNTER_BITS, registerBits: LOGLOG_REGISTER_BITS, defaultError: balance.EXPORT_DEFAULT_ERROR };
}

export interface Workload {
  /** Values that will be inserted (counting repeats). */
  items?: number;
  /** Different values among them. */
  distinct?: number;
  /** Acceptable relative error, between 0 and 1. */
  error?: number;
  /** Memory the structure may use, in bits. */
  memoryBits?: number;
}

interface Sized {
  memoryBits: number;
  /** True when no target was given or the target was reached. */
  meetsTarget: boolean;
}

function need(name: string, value: number | undefined): number {
  if (value === undefined || !(value > 0)) throw new RangeError(`The workload needs ${name}, a positive number`);
  return value;
}

function target(workload: Workload, constants: SizingConstants): number {
  if (workload.error === undefined) return constants.defaultError;
  if (!(workload.error > 0 && workload.error < 1)) throw new RangeError("The acceptable error must be between 0 and 1");
  return workload.error;
}

const meets = (workload: Workload, achieved: number) => workload.error === undefined || achieved <= workload.error;
const LN2 = Math.LN2;
/** No sizing search goes past this many bits (2^50), which stops a target that cannot be met from looping. */
const MAX_BITS = 2 ** 50;

export interface BloomSizing extends Sized {
  bits: number;
  hashes: number;
  falsePositiveRate: number;
}

export function sizeBloom(workload: Workload, constants: SizingConstants): BloomSizing {
  const n = need("the item count", workload.items);
  const rateFor = (bits: number) => {
    const hashes = Math.max(1, Math.round((bits / n) * LN2));
    return { hashes, rate: Math.pow(1 - Math.exp((-hashes * n) / bits), hashes) };
  };
  let bits = workload.memoryBits;
  if (bits === undefined) {
    const wanted = target(workload, constants);
    bits = Math.ceil((-n * Math.log(wanted)) / LN2 ** 2);
    while (rateFor(bits).rate > wanted) bits++; // the hash count is a whole number, which can leave the formula's size a hair short
  }
  const { hashes, rate } = rateFor(bits);
  return { bits, hashes, falsePositiveRate: rate, memoryBits: bits, meetsTarget: meets(workload, rate) };
}

export interface CountMinSizing extends Sized {
  width: number;
  depth: number;
  /** The most an estimate overshoots, as a share of the items, with probability `confidence`. */
  errorShare: number;
  /** The same in counts, for the item count given (0 when it was not). */
  overshoot: number;
  confidence: number;
}

export function sizeCountMin(workload: Workload, constants: SizingConstants): CountMinSizing {
  const depth = Math.max(1, Math.ceil(Math.log(1 / (1 - constants.confidence))));
  const cells = (width: number) => width * depth * constants.counterBits;
  const width = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / (depth * constants.counterBits))) : Math.ceil(Math.E / target(workload, constants));
  const errorShare = Math.E / width;
  return {
    width,
    depth,
    errorShare,
    overshoot: errorShare * (workload.items ?? 0),
    confidence: 1 - Math.exp(-depth),
    memoryBits: cells(width),
    meetsTarget: meets(workload, errorShare),
  };
}

/** The fewest index bits a register structure is sized to (16 registers), as in the game and the toolkit. */
const MIN_INDEX_BITS = 4;

export interface RegisterSizing extends Sized {
  /** The register count is 2^indexBits. */
  indexBits: number;
  registers: number;
  standardError: number;
}

function sizeRegisters(workload: Workload, constants: SizingConstants, coefficient: number): RegisterSizing {
  const indexBits = Math.max(
    MIN_INDEX_BITS,
    workload.memoryBits !== undefined ? Math.floor(Math.log2(workload.memoryBits / constants.registerBits)) : Math.ceil(Math.log2((coefficient / target(workload, constants)) ** 2)),
  );
  const registers = 2 ** indexBits;
  const standardError = coefficient / Math.sqrt(registers);
  return { indexBits, registers, standardError, memoryBits: registers * constants.registerBits, meetsTarget: meets(workload, standardError) };
}

export const sizeHyperLogLog = (workload: Workload, constants: SizingConstants) => sizeRegisters(workload, constants, constants.hyperLogLogErrorCoefficient);
export const sizeLogLog = (workload: Workload, constants: SizingConstants) => sizeRegisters(workload, constants, constants.logLogErrorCoefficient);

export interface LinearCountingSizing extends Sized {
  bits: number;
  standardError: number;
}

/** Linear Counting's standard error for n distinct values in m bits: sqrt(m (e^t - t - 1)) / n with t = n / m. */
function linearError(n: number, m: number): number {
  const load = n / m;
  return Math.sqrt(m * (Math.exp(load) - load - 1)) / n;
}

export function sizeLinearCounting(workload: Workload, constants: SizingConstants): LinearCountingSizing {
  const n = need("the distinct count", workload.distinct);
  let bits: number;
  if (workload.memoryBits !== undefined) bits = Math.max(1, Math.floor(workload.memoryBits));
  else {
    const wanted = target(workload, constants);
    let low = 1;
    let high = Math.max(2, Math.ceil(n)); // at one bit per value the error is already small, so the answer is not above this
    while (linearError(n, high) > wanted) {
      high *= 2;
      if (!Number.isFinite(high) || high > MAX_BITS) throw new RangeError("No bit array reaches that error for this many distinct values");
    }
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (linearError(n, mid) <= wanted) high = mid;
      else low = mid + 1;
    }
    bits = low;
  }
  const standardError = linearError(n, bits);
  return { bits, standardError, memoryBits: bits, meetsTarget: meets(workload, standardError) };
}

export interface ReservoirSizing extends Sized {
  sampleSize: number;
  /** Worst-case error of a share estimated from the sample, at the confidence. */
  error: number;
}

/** The two-sided normal quantile for the confidence, by a short search on the error function (no table of magic numbers). */
function zFor(confidence: number): number {
  let low = 0;
  let high = 10;
  const coverage = (z: number) => erf(z / Math.SQRT2);
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (coverage(mid) < confidence) low = mid;
    else high = mid;
  }
  return high;
}

function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26, accurate to 1.5e-7, plenty for a sample-size rule.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return Math.sign(x) * (1 - poly * Math.exp(-x * x));
}

export function sizeReservoir(workload: Workload, constants: SizingConstants): ReservoirSizing {
  const z = zFor(constants.confidence);
  const bitsPerValue = constants.valueBits;
  const sampleSize = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / bitsPerValue)) : Math.ceil((z * z * 0.25) / target(workload, constants) ** 2);
  const error = (z * 0.5) / Math.sqrt(sampleSize);
  return { sampleSize, error, memoryBits: sampleSize * bitsPerValue, meetsTarget: meets(workload, error) };
}

export interface ExactSizing extends Sized {
  entries: number;
}

/** Exact Memory keeps every distinct value and a counter for it, so it has no error and costs the most. */
export function sizeExact(workload: Workload, constants: SizingConstants): ExactSizing {
  const entries = Math.ceil(need("the distinct count", workload.distinct));
  const memoryBits = entries * (constants.valueBits + constants.counterBits);
  return { entries, memoryBits, meetsTarget: workload.memoryBits === undefined || memoryBits <= workload.memoryBits };
}

export interface CountSketchSizing extends Sized {
  width: number;
  depth: number;
  /** The error either way, as a share of the L2 norm of the counts (the square root of the sum of their squares), with probability `confidence`. */
  errorShare: number;
  confidence: number;
}

/**
 * Count Sketch: a row's error exceeds epsilon x L2 norm with probability at most 1 / (width x epsilon^2) (Chebyshev), so width = 4 / epsilon^2 makes a
 * row wrong with probability at most 1/4, and the median of an odd number of rows is wrong only if half of them are, which has probability at most
 * e^(-depth x D) with D = (1/2) ln 2 + (1/2) ln (2/3), the relative entropy of one half against one quarter. The depth is the smallest odd one with that
 * under 1 - confidence. Given a memory budget, the width is what fits and epsilon is 2 / sqrt(width).
 */
export function sizeCountSketch(workload: Workload, constants: SizingConstants): CountSketchSizing {
  const entropy = 0.5 * Math.log(2) + 0.5 * Math.log(2 / 3);
  let depth = Math.max(1, Math.ceil(Math.log(1 / (1 - constants.confidence)) / entropy));
  if (depth % 2 === 0) depth++;
  const width = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / (depth * constants.counterBits))) : Math.ceil(4 / target(workload, constants) ** 2);
  const errorShare = 2 / Math.sqrt(width);
  return { width, depth, errorShare, confidence: constants.confidence, memoryBits: width * depth * constants.counterBits, meetsTarget: meets(workload, errorShare) };
}

/** A Cuckoo Filter's buckets hold four fingerprints, and it works up to about this share full. */
const CUCKOO_BUCKET_SIZE = 4;
const CUCKOO_MAX_LOAD = 0.95;

export interface CuckooSizing extends Sized {
  buckets: number;
  fingerprintBits: number;
  falsePositiveRate: number;
}

/** False positives are about 2 x bucket size / 2^f at full load: f = ceil(log2(8 / error)). Given memory, the fingerprint is what fits. */
export function sizeCuckoo(workload: Workload, constants: SizingConstants): CuckooSizing {
  const n = need("the item count", workload.items);
  const buckets = Math.ceil(n / (CUCKOO_BUCKET_SIZE * CUCKOO_MAX_LOAD));
  const fingerprintBits =
    workload.memoryBits !== undefined
      ? Math.min(16, Math.max(1, Math.floor(workload.memoryBits / (buckets * CUCKOO_BUCKET_SIZE))))
      : Math.min(16, Math.max(1, Math.ceil(Math.log2((2 * CUCKOO_BUCKET_SIZE) / target(workload, constants)))));
  const falsePositiveRate = (2 * CUCKOO_BUCKET_SIZE) / 2 ** fingerprintBits;
  return { buckets, fingerprintBits, falsePositiveRate, memoryBits: buckets * CUCKOO_BUCKET_SIZE * fingerprintBits, meetsTarget: meets(workload, falsePositiveRate) };
}

export interface KmvSizing extends Sized {
  k: number;
  standardError: number;
}

/** K-Minimum Values: relative standard error 1 / sqrt(k - 2), so k = 1 / error^2 + 2, at 32 bits a hash. */
export function sizeKmv(workload: Workload, constants: SizingConstants): KmvSizing {
  const k = workload.memoryBits !== undefined ? Math.max(3, Math.floor(workload.memoryBits / constants.valueBits)) : Math.ceil(1 / target(workload, constants) ** 2) + 2;
  const standardError = 1 / Math.sqrt(k - 2);
  return { k, standardError, memoryBits: k * constants.valueBits, meetsTarget: meets(workload, standardError) };
}

export interface MinHashSizing extends Sized {
  k: number;
  /** The most the standard error of an estimated similarity can be. */
  standardError: number;
}

/** MinHash: standard error at most 1 / (2 sqrt(k)), so k = 1 / (4 error^2), at 32 bits a slot. */
export function sizeMinHash(workload: Workload, constants: SizingConstants): MinHashSizing {
  const k = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / constants.valueBits)) : Math.ceil(1 / (4 * target(workload, constants) ** 2));
  const standardError = 1 / (2 * Math.sqrt(k));
  return { k, standardError, memoryBits: k * constants.valueBits, meetsTarget: meets(workload, standardError) };
}

export interface QuotientSizing extends Sized {
  quotientBits: number;
  remainderBits: number;
  slots: number;
  falsePositiveRate: number;
}

/** A Quotient Filter is run up to this share full. */
const QUOTIENT_MAX_LOAD = 0.9;

/** q = ceil(log2(items / 0.9)); false positives are the load times 2^-r, so r = ceil(log2(load / error)); the table is 2^q (r + 3) bits. Given memory, r is what fits. */
export function sizeQuotient(workload: Workload, constants: SizingConstants): QuotientSizing {
  const n = need("the item count", workload.items);
  const quotientBits = Math.max(2, Math.ceil(Math.log2(n / QUOTIENT_MAX_LOAD)));
  const slots = 2 ** quotientBits;
  const load = n / slots;
  const remainderBits =
    workload.memoryBits !== undefined ? Math.min(16, Math.max(1, Math.floor(workload.memoryBits / slots) - 3)) : Math.min(16, Math.max(1, Math.ceil(Math.log2(load / target(workload, constants)))));
  const falsePositiveRate = load * 2 ** -remainderBits;
  return { quotientBits, remainderBits, slots, falsePositiveRate, memoryBits: slots * (remainderBits + 3), meetsTarget: meets(workload, falsePositiveRate) };
}

export interface SpectralSizing extends Sized {
  counters: number;
  hashes: number;
  falsePositiveRate: number;
  /** The most a count is likely to overshoot, as a share of the items added (e k / counters). */
  overshootShare: number;
}

/** A Bloom filter's size for the false-positive rate, in 16-bit counters; a count overshoots by at most e k N / counters. */
export function sizeSpectral(workload: Workload, constants: SizingConstants): SpectralSizing {
  const n = need("the item count", workload.items);
  const counterBits = constants.spectralCounterBits;
  const rateFor = (counters: number) => {
    const hashes = Math.max(1, Math.round((counters / n) * LN2));
    return { hashes, rate: Math.pow(1 - Math.exp((-hashes * n) / counters), hashes) };
  };
  let counters = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / counterBits)) : undefined;
  if (counters === undefined) {
    const wanted = target(workload, constants);
    counters = Math.ceil((-n * Math.log(wanted)) / LN2 ** 2);
    while (rateFor(counters).rate > wanted) counters++;
  }
  const { hashes, rate } = rateFor(counters);
  return { counters, hashes, falsePositiveRate: rate, overshootShare: (Math.E * hashes) / counters, memoryBits: counters * counterBits, meetsTarget: meets(workload, rate) };
}

export interface ScalableSizing extends Sized {
  initialCapacity: number;
  falsePositiveRate: number;
  layers: number;
}

/** A Scalable Bloom Filter for an expected number of items: the first layer holds a seventh of them, so three layers (1 + 2 + 4 sevenths) hold them all; it grows past that on its own. */
export function sizeScalable(workload: Workload, constants: SizingConstants): ScalableSizing {
  const n = need("the item count", workload.items);
  const rate = target(workload, constants);
  const initialCapacity = Math.max(1, Math.ceil(n / 7));
  let layers = 1;
  while (initialCapacity * (2 ** layers - 1) < n) layers++;
  let bits = 0;
  for (let i = 0; i < layers; i++) {
    const capacity = initialCapacity * 2 ** i;
    bits += Math.ceil((-capacity * Math.log(rate * 0.45 * 0.5 ** i)) / LN2 ** 2);
  }
  return { initialCapacity, falsePositiveRate: rate, layers, memoryBits: bits, meetsTarget: workload.memoryBits === undefined || bits <= workload.memoryBits };
}

export interface SimHashSizing extends Sized {
  planes: number;
  /** The most the standard error of the estimated angle, as a share of pi, can be. */
  standardError: number;
}

/** The share of planes that disagree has a standard error of at most 1 / (2 sqrt(planes)), so planes = 1 / (4 error^2), rounded up to a multiple of 32; a counter is 16 bits. */
export function sizeSimHash(workload: Workload, constants: SizingConstants): SimHashSizing {
  const planes = workload.memoryBits !== undefined ? Math.max(32, Math.floor(workload.memoryBits / constants.simHashCounterBits / 32) * 32) : Math.max(32, Math.ceil(1 / (4 * target(workload, constants) ** 2) / 32) * 32);
  const standardError = 1 / (2 * Math.sqrt(planes));
  return { planes, standardError, memoryBits: planes * constants.simHashCounterBits, meetsTarget: meets(workload, standardError) };
}

/** What the level `depth` below the top of a KLL Sketch holds: k x (2/3)^depth rounded up, none below 2, worked out in whole numbers. */
function kllLevel(k: number, depth: number): number {
  return Math.max(2, Math.floor((k * 2 ** depth + 3 ** depth - 1) / 3 ** depth));
}

/** The levels a KLL Sketch plans for (it takes streams of k x 2^23 items). */
const KLL_LEVELS = 24;

export interface KllSizing extends Sized {
  k: number;
  /** The rank error as a share of the items (the 95th percentile of the error, found by simulation): 1.6 / k. */
  rankError: number;
}

export function sizeKll(workload: Workload, constants: SizingConstants): KllSizing {
  const bitsFor = (k: number) => constants.valueBits * Array.from({ length: KLL_LEVELS }, (_, depth) => kllLevel(k, depth)).reduce((a, b) => a + b, 0);
  let k = Math.max(2, Math.ceil(constants.kllRankError / target(workload, constants)));
  if (workload.memoryBits !== undefined) {
    let low = 2; // the largest k whose levels fit, by bisection (the memory grows with k)
    let high = 2;
    while (bitsFor(high) <= workload.memoryBits && high < 2 ** 40) high *= 2;
    while (low < high - 1) {
      const mid = Math.floor((low + high) / 2);
      if (bitsFor(mid) <= workload.memoryBits) low = mid;
      else high = mid;
    }
    k = low;
  }
  const rankError = constants.kllRankError / k;
  return { k, rankError, memoryBits: bitsFor(k), meetsTarget: meets(workload, rankError) };
}

export interface TDigestSizing extends Sized {
  compression: number;
  /** The rank error at the median, where it is largest, as a share of the values: 2 / compression. In the tails it is much smaller. */
  rankError: number;
}

/** A t-digest's rank error at quantile q is 4 sqrt(q (1 - q)) / compression, so at the median 2 / compression; a centroid is a 32-bit mean and a 32-bit weight. */
export function sizeTDigest(workload: Workload, constants: SizingConstants): TDigestSizing {
  const compression = workload.memoryBits !== undefined ? Math.max(8, Math.floor(workload.memoryBits / (2 * constants.counterBits))) : Math.max(8, Math.ceil(2 / target(workload, constants)));
  const rankError = 2 / compression;
  return { compression, rankError, memoryBits: compression * 2 * constants.counterBits, meetsTarget: meets(workload, rankError) };
}

export interface DyadicSizing extends Sized {
  /** The bits of the value used: all 32. */
  bits: number;
  width: number;
  depth: number;
  /** The most the rank of a value overshoots, as a share of the items, with probability `confidence`. */
  rankError: number;
  confidence: number;
}

const DYADIC_BITS = 32;
const DYADIC_EXACT_MAX = 64;

/**
 * Dyadic Count-Min over 32-bit values: the levels with more than 64 intervals (26 of the 32) are Count-Min Sketches, so a rank is the sum of up to that many
 * overshoots of e / width of the items each; width = ceil(26 e / error). The chance that any of them is off by more than its band is at most 26 e^-depth
 * (a union bound), so depth = ceil(ln(26 / (1 - confidence))). The 6 exact levels hold 126 counters.
 */
export function sizeDyadic(workload: Workload, constants: SizingConstants): DyadicSizing {
  const sketchLevels = Array.from({ length: DYADIC_BITS }, (_, j) => j).filter((j) => 2 ** (DYADIC_BITS - j) > DYADIC_EXACT_MAX).length;
  const exactBits = Array.from({ length: DYADIC_BITS }, (_, j) => j).filter((j) => 2 ** (DYADIC_BITS - j) <= DYADIC_EXACT_MAX).reduce((sum, j) => sum + 2 ** (DYADIC_BITS - j), 0) * constants.counterBits;
  const depth = Math.max(1, Math.ceil(Math.log(sketchLevels / (1 - constants.confidence))));
  const width =
    workload.memoryBits !== undefined
      ? Math.max(1, Math.floor((workload.memoryBits - exactBits) / (sketchLevels * depth * constants.counterBits)))
      : Math.ceil((sketchLevels * Math.E) / target(workload, constants));
  const rankError = (sketchLevels * Math.E) / width;
  return { bits: DYADIC_BITS, width, depth, rankError, confidence: constants.confidence, memoryBits: sketchLevels * width * depth * constants.counterBits + exactBits, meetsTarget: meets(workload, rankError) };
}

export interface TopKSizing extends Sized {
  width: number;
  depth: number;
  capacity: number;
  /** The sketch's overshoot as a share of the items, with probability `confidence`. */
  errorShare: number;
  confidence: number;
}

/** A Count-Min Sketch of width e / error and depth ln(1 / (1 - confidence)), and a list of 1 / error candidates of three 32-bit numbers each (the item and two bounds). */
export function sizeTopK(workload: Workload, constants: SizingConstants): TopKSizing {
  const entryBits = constants.valueBits + 2 * constants.counterBits;
  const depth = Math.max(1, Math.ceil(Math.log(1 / (1 - constants.confidence))));
  let width = Math.ceil(Math.E / target(workload, constants));
  let capacity = Math.ceil(1 / target(workload, constants));
  if (workload.memoryBits !== undefined) {
    capacity = Math.max(1, Math.floor((workload.memoryBits * 0.25) / entryBits));
    width = Math.max(1, Math.floor((workload.memoryBits - capacity * entryBits) / (depth * constants.counterBits)));
  }
  const errorShare = Math.E / width;
  return { width, depth, capacity, errorShare, confidence: 1 - Math.exp(-depth), memoryBits: width * depth * constants.counterBits + capacity * entryBits, meetsTarget: meets(workload, errorShare) };
}
