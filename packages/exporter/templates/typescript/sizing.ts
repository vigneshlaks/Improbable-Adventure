// Sizing calculator: your real workload in, parameters out.
// Every function takes { items, distinct, error, memoryBits } (any may be left out) and returns the parameters to
// construct the structure with, the error they give and the memory they take.
//   - give `error`: the smallest memory that reaches it is chosen;
//   - give `memoryBits`: the error that memory gives is reported;
//   - give both: the memory is used and `meetsTarget` says whether the error was reached;
//   - give neither: a default target of 1% is used.
// Errors are relative (0.01 is 1%). Probabilistic bounds hold at CONFIDENCE.

export const CONFIDENCE = 0.95;
export const DEFAULT_ERROR = 0.01;
export const VALUE_BITS = 32;
export const COUNTER_BITS = 32;
export const REGISTER_BITS = 5;
export const HLL_ERROR_COEFFICIENT = 1.04;
export const LOGLOG_ERROR_COEFFICIENT = 1.3;
/** The fewest index bits a register structure is sized to (16 registers). */
const MIN_INDEX_BITS = 4;
/** The most bits a search will try, which stops a target that cannot be met from looping. */
const MAX_BITS = 2 ** 50;

export interface Workload {
  /** How many items will be added (counting repeats). */
  items?: number;
  /** How many different items there are among them. */
  distinct?: number;
  /** The relative error you can accept, between 0 and 1. */
  error?: number;
  /** The memory the structure may use, in bits. */
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

function target(workload: Workload): number {
  if (workload.error === undefined) return DEFAULT_ERROR;
  if (!(workload.error > 0 && workload.error < 1)) throw new RangeError("The acceptable error must be between 0 and 1");
  return workload.error;
}

const meets = (workload: Workload, achieved: number): boolean => workload.error === undefined || achieved <= workload.error;

export interface BloomSizing extends Sized {
  bits: number;
  hashes: number;
  falsePositiveRate: number;
}

export function sizeBloom(workload: Workload): BloomSizing {
  const n = need("items", workload.items);
  const rateFor = (bits: number) => {
    const hashes = Math.max(1, Math.round((bits / n) * Math.LN2));
    return { hashes, rate: (1 - Math.exp((-hashes * n) / bits)) ** hashes };
  };
  let bits = workload.memoryBits;
  if (bits === undefined) {
    const wanted = target(workload);
    bits = Math.ceil((-n * Math.log(wanted)) / Math.LN2 ** 2);
    while (rateFor(bits).rate > wanted) bits++; // the hash count is a whole number, which can leave the formula's size a hair short
  }
  const { hashes, rate } = rateFor(bits);
  return { bits, hashes, falsePositiveRate: rate, memoryBits: bits, meetsTarget: meets(workload, rate) };
}

export interface CountMinSizing extends Sized {
  width: number;
  depth: number;
  /** The most an estimate overshoots, as a share of the items added, with probability `confidence`. */
  errorShare: number;
  /** The same in counts, for the `items` given (0 when it was not). */
  overshoot: number;
  confidence: number;
}

export function sizeCountMin(workload: Workload): CountMinSizing {
  const depth = Math.max(1, Math.ceil(Math.log(1 / (1 - CONFIDENCE))));
  const width = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / (depth * COUNTER_BITS))) : Math.ceil(Math.E / target(workload));
  const errorShare = Math.E / width;
  return {
    width,
    depth,
    errorShare,
    overshoot: errorShare * (workload.items ?? 0),
    confidence: 1 - Math.exp(-depth),
    memoryBits: width * depth * COUNTER_BITS,
    meetsTarget: meets(workload, errorShare),
  };
}

export interface RegisterSizing extends Sized {
  /** Pass this to the constructor: there are 2^indexBits registers. */
  indexBits: number;
  registers: number;
  standardError: number;
}

function sizeRegisters(workload: Workload, coefficient: number): RegisterSizing {
  const indexBits = Math.max(
    MIN_INDEX_BITS,
    workload.memoryBits !== undefined ? Math.floor(Math.log2(workload.memoryBits / REGISTER_BITS)) : Math.ceil(Math.log2((coefficient / target(workload)) ** 2)),
  );
  const registers = 2 ** indexBits;
  const standardError = coefficient / Math.sqrt(registers);
  return { indexBits, registers, standardError, memoryBits: registers * REGISTER_BITS, meetsTarget: meets(workload, standardError) };
}

export const sizeHyperLogLog = (workload: Workload): RegisterSizing => sizeRegisters(workload, HLL_ERROR_COEFFICIENT);
export const sizeLogLog = (workload: Workload): RegisterSizing => sizeRegisters(workload, LOGLOG_ERROR_COEFFICIENT);

export interface LinearCountingSizing extends Sized {
  bits: number;
  standardError: number;
}

/** Standard error of Linear Counting for n different items in m bits: sqrt(m (e^t - t - 1)) / n with t = n / m. */
function linearError(n: number, m: number): number {
  const load = n / m;
  return Math.sqrt(m * (Math.exp(load) - load - 1)) / n;
}

export function sizeLinearCounting(workload: Workload): LinearCountingSizing {
  const n = need("distinct", workload.distinct);
  let bits: number;
  if (workload.memoryBits !== undefined) bits = Math.max(1, Math.floor(workload.memoryBits));
  else {
    const wanted = target(workload);
    let low = 1;
    let high = Math.max(2, Math.ceil(n));
    while (linearError(n, high) > wanted) {
      high *= 2;
      if (!Number.isFinite(high) || high > MAX_BITS) throw new RangeError("No bit array reaches that error for this many different items");
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

/** The two-sided normal quantile for a confidence (1.96 for 95%), found by bisection on the error function. */
function zFor(confidence: number): number {
  const erf = (x: number): number => {
    // Abramowitz and Stegun 7.1.26, accurate to 1.5e-7.
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return Math.sign(x) * (1 - poly * Math.exp(-x * x));
  };
  let low = 0;
  let high = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (erf(mid / Math.SQRT2) < confidence) low = mid;
    else high = mid;
  }
  return high;
}

export interface ReservoirSizing extends Sized {
  sampleSize: number;
  /** Worst-case error of a share estimated from the sample, at the confidence. */
  error: number;
}

export function sizeReservoir(workload: Workload): ReservoirSizing {
  const z = zFor(CONFIDENCE);
  const sampleSize =
    workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / VALUE_BITS)) : Math.ceil((z * z * 0.25) / target(workload) ** 2);
  const error = (z * 0.5) / Math.sqrt(sampleSize);
  return { sampleSize, error, memoryBits: sampleSize * VALUE_BITS, meetsTarget: meets(workload, error) };
}

export interface ExactSizing extends Sized {
  entries: number;
}

/** Exact Memory keeps every different item and a counter for it: no error, and the most memory. */
export function sizeExact(workload: Workload): ExactSizing {
  const entries = Math.ceil(need("distinct", workload.distinct));
  const memoryBits = entries * (VALUE_BITS + COUNTER_BITS);
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
export function sizeCountSketch(workload: Workload): CountSketchSizing {
  const entropy = 0.5 * Math.log(2) + 0.5 * Math.log(2 / 3);
  let depth = Math.max(1, Math.ceil(Math.log(1 / (1 - CONFIDENCE)) / entropy));
  if (depth % 2 === 0) depth++;
  const width = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / (depth * COUNTER_BITS))) : Math.ceil(4 / target(workload) ** 2);
  const errorShare = 2 / Math.sqrt(width);
  return { width, depth, errorShare, confidence: CONFIDENCE, memoryBits: width * depth * COUNTER_BITS, meetsTarget: meets(workload, errorShare) };
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
export function sizeCuckoo(workload: Workload): CuckooSizing {
  const n = need("items", workload.items);
  const buckets = Math.ceil(n / (CUCKOO_BUCKET_SIZE * CUCKOO_MAX_LOAD));
  const fingerprintBits =
    workload.memoryBits !== undefined
      ? Math.min(16, Math.max(1, Math.floor(workload.memoryBits / (buckets * CUCKOO_BUCKET_SIZE))))
      : Math.min(16, Math.max(1, Math.ceil(Math.log2((2 * CUCKOO_BUCKET_SIZE) / target(workload)))));
  const falsePositiveRate = (2 * CUCKOO_BUCKET_SIZE) / 2 ** fingerprintBits;
  return { buckets, fingerprintBits, falsePositiveRate, memoryBits: buckets * CUCKOO_BUCKET_SIZE * fingerprintBits, meetsTarget: meets(workload, falsePositiveRate) };
}

export interface KmvSizing extends Sized {
  k: number;
  standardError: number;
}

/** K-Minimum Values: relative standard error 1 / sqrt(k - 2), so k = 1 / error^2 + 2, at 32 bits a hash. */
export function sizeKmv(workload: Workload): KmvSizing {
  const k = workload.memoryBits !== undefined ? Math.max(3, Math.floor(workload.memoryBits / VALUE_BITS)) : Math.ceil(1 / target(workload) ** 2) + 2;
  const standardError = 1 / Math.sqrt(k - 2);
  return { k, standardError, memoryBits: k * VALUE_BITS, meetsTarget: meets(workload, standardError) };
}

export interface MinHashSizing extends Sized {
  k: number;
  /** The most the standard error of an estimated similarity can be. */
  standardError: number;
}

/** MinHash: standard error at most 1 / (2 sqrt(k)), so k = 1 / (4 error^2), at 32 bits a slot. */
export function sizeMinHash(workload: Workload): MinHashSizing {
  const k = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / VALUE_BITS)) : Math.ceil(1 / (4 * target(workload) ** 2));
  const standardError = 1 / (2 * Math.sqrt(k));
  return { k, standardError, memoryBits: k * VALUE_BITS, meetsTarget: meets(workload, standardError) };
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
export function sizeQuotient(workload: Workload): QuotientSizing {
  const n = need("items", workload.items);
  const quotientBits = Math.max(2, Math.ceil(Math.log2(n / QUOTIENT_MAX_LOAD)));
  const slots = 2 ** quotientBits;
  const load = n / slots;
  const remainderBits =
    workload.memoryBits !== undefined ? Math.min(16, Math.max(1, Math.floor(workload.memoryBits / slots) - 3)) : Math.min(16, Math.max(1, Math.ceil(Math.log2(load / target(workload)))));
  const falsePositiveRate = load * 2 ** -remainderBits;
  return { quotientBits, remainderBits, slots, falsePositiveRate, memoryBits: slots * (remainderBits + 3), meetsTarget: meets(workload, falsePositiveRate) };
}

/** The bits of a Spectral Bloom Filter's counter, as in the game. */
export const SPECTRAL_COUNTER_BITS = 16;

export interface SpectralSizing extends Sized {
  counters: number;
  hashes: number;
  falsePositiveRate: number;
  /** The most a count is likely to overshoot, as a share of the items added (e k / counters). */
  overshootShare: number;
}

/** A Bloom filter's size for the false-positive rate, in 16-bit counters; a count overshoots by at most e k N / counters. */
export function sizeSpectral(workload: Workload): SpectralSizing {
  const n = need("items", workload.items);
  const rateFor = (counters: number) => {
    const hashes = Math.max(1, Math.round((counters / n) * Math.LN2));
    return { hashes, rate: (1 - Math.exp((-hashes * n) / counters)) ** hashes };
  };
  let counters = workload.memoryBits !== undefined ? Math.max(1, Math.floor(workload.memoryBits / SPECTRAL_COUNTER_BITS)) : undefined;
  if (counters === undefined) {
    const wanted = target(workload);
    counters = Math.ceil((-n * Math.log(wanted)) / Math.LN2 ** 2);
    while (rateFor(counters).rate > wanted) counters++;
  }
  const { hashes, rate } = rateFor(counters);
  return { counters, hashes, falsePositiveRate: rate, overshootShare: (Math.E * hashes) / counters, memoryBits: counters * SPECTRAL_COUNTER_BITS, meetsTarget: meets(workload, rate) };
}

export interface ScalableSizing extends Sized {
  initialCapacity: number;
  falsePositiveRate: number;
  layers: number;
}

/** A Scalable Bloom Filter for an expected number of items: the first layer holds a seventh of them, so three layers (1 + 2 + 4 sevenths) hold them all; it grows past that on its own. */
export function sizeScalable(workload: Workload): ScalableSizing {
  const n = need("items", workload.items);
  const rate = target(workload);
  const initialCapacity = Math.max(1, Math.ceil(n / 7));
  let layers = 1;
  while (initialCapacity * (2 ** layers - 1) < n) layers++;
  let bits = 0;
  for (let i = 0; i < layers; i++) {
    const capacity = initialCapacity * 2 ** i;
    bits += Math.ceil((-capacity * Math.log(rate * 0.45 * 0.5 ** i)) / Math.LN2 ** 2);
  }
  return { initialCapacity, falsePositiveRate: rate, layers, memoryBits: bits, meetsTarget: workload.memoryBits === undefined || bits <= workload.memoryBits };
}

/** The bits of a SimHash counter, as in the game. */
export const SIMHASH_COUNTER_BITS = 16;

export interface SimHashSizing extends Sized {
  planes: number;
  /** The most the standard error of the estimated angle, as a share of pi, can be. */
  standardError: number;
}

/** The share of planes that disagree has a standard error of at most 1 / (2 sqrt(planes)), so planes = 1 / (4 error^2), rounded up to a multiple of 32; a counter is 16 bits. */
export function sizeSimHash(workload: Workload): SimHashSizing {
  const planes = workload.memoryBits !== undefined ? Math.max(32, Math.floor(workload.memoryBits / SIMHASH_COUNTER_BITS / 32) * 32) : Math.max(32, Math.ceil(1 / (4 * target(workload) ** 2) / 32) * 32);
  const standardError = 1 / (2 * Math.sqrt(planes));
  return { planes, standardError, memoryBits: planes * SIMHASH_COUNTER_BITS, meetsTarget: meets(workload, standardError) };
}

/** What the level `depth` below the top of a KLL Sketch holds: k x (2/3)^depth rounded up, none below 2, worked out in whole numbers. */
function kllLevel(k: number, depth: number): number {
  return Math.max(2, Math.floor((k * 2 ** depth + 3 ** depth - 1) / 3 ** depth));
}

/** The levels a KLL Sketch plans for (it takes streams of k x 2^23 items), and the rank error coefficient found by simulation. */
const KLL_LEVELS = 24;
export const KLL_RANK_ERROR = 1.6;

export interface KllSizing extends Sized {
  k: number;
  /** The rank error as a share of the items (the 95th percentile of the error, found by simulation): 1.6 / k. */
  rankError: number;
}

export function sizeKll(workload: Workload): KllSizing {
  const bitsFor = (k: number) => VALUE_BITS * Array.from({ length: KLL_LEVELS }, (_, depth) => kllLevel(k, depth)).reduce((a, b) => a + b, 0);
  let k = Math.max(2, Math.ceil(KLL_RANK_ERROR / target(workload)));
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
  const rankError = KLL_RANK_ERROR / k;
  return { k, rankError, memoryBits: bitsFor(k), meetsTarget: meets(workload, rankError) };
}

export interface TDigestSizing extends Sized {
  compression: number;
  /** The rank error at the median, where it is largest, as a share of the values: 2 / compression. In the tails it is much smaller. */
  rankError: number;
}

/** A t-digest's rank error at quantile q is 4 sqrt(q (1 - q)) / compression, so at the median 2 / compression; a centroid is a 32-bit mean and a 32-bit weight. */
export function sizeTDigest(workload: Workload): TDigestSizing {
  const compression = workload.memoryBits !== undefined ? Math.max(8, Math.floor(workload.memoryBits / (2 * COUNTER_BITS))) : Math.max(8, Math.ceil(2 / target(workload)));
  const rankError = 2 / compression;
  return { compression, rankError, memoryBits: compression * 2 * COUNTER_BITS, meetsTarget: meets(workload, rankError) };
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
export function sizeDyadic(workload: Workload): DyadicSizing {
  const levels = Array.from({ length: DYADIC_BITS }, (_, j) => j);
  const sketchLevels = levels.filter((j) => 2 ** (DYADIC_BITS - j) > DYADIC_EXACT_MAX).length;
  const exactBits = levels.filter((j) => 2 ** (DYADIC_BITS - j) <= DYADIC_EXACT_MAX).reduce((sum, j) => sum + 2 ** (DYADIC_BITS - j), 0) * COUNTER_BITS;
  const depth = Math.max(1, Math.ceil(Math.log(sketchLevels / (1 - CONFIDENCE))));
  const width =
    workload.memoryBits !== undefined
      ? Math.max(1, Math.floor((workload.memoryBits - exactBits) / (sketchLevels * depth * COUNTER_BITS)))
      : Math.ceil((sketchLevels * Math.E) / target(workload));
  const rankError = (sketchLevels * Math.E) / width;
  return { bits: DYADIC_BITS, width, depth, rankError, confidence: CONFIDENCE, memoryBits: sketchLevels * width * depth * COUNTER_BITS + exactBits, meetsTarget: meets(workload, rankError) };
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
export function sizeTopK(workload: Workload): TopKSizing {
  const entryBits = VALUE_BITS + 2 * COUNTER_BITS;
  const depth = Math.max(1, Math.ceil(Math.log(1 / (1 - CONFIDENCE))));
  let width = Math.ceil(Math.E / target(workload));
  let capacity = Math.ceil(1 / target(workload));
  if (workload.memoryBits !== undefined) {
    capacity = Math.max(1, Math.floor((workload.memoryBits * 0.25) / entryBits));
    width = Math.max(1, Math.floor((workload.memoryBits - capacity * entryBits) / (depth * COUNTER_BITS)));
  }
  const errorShare = Math.E / width;
  return { width, depth, capacity, errorShare, confidence: 1 - Math.exp(-depth), memoryBits: width * depth * COUNTER_BITS + capacity * entryBits, meetsTarget: meets(workload, errorShare) };
}

/** The chance that some band of `rows` rows agrees for two sets of similarity s, with `bands` bands. */
export function lshChance(similarity: number, rows: number, bands: number): number {
  return 1 - (1 - similarity ** rows) ** bands;
}

/** The similarity an LSH index is built to find, and the similarity at which it is asked to turn most pairs away. */
const LSH_THRESHOLD = 0.6;
const LSH_FAR = 0.4;

export interface LshSizing extends Sized {
  /** The minima in a signature, and how they are cut into bands. */
  k: number;
  rows: number;
  bands: number;
  /** The chance a pair exactly at the threshold (0.6) is found, and the chance a pair at 0.4 is found anyway. */
  recall: number;
  falseAlarm: number;
}

/**
 * LSH: `error` is the share of pairs at the threshold the index may miss. Over the row counts, the bands needed for that recall are b = ceil(ln(error) / ln(1 - t^r));
 * the row count that turns most pairs at 0.4 away is chosen, and the signature is k = r b minima of 32 bits. Given memory, k is what fits and the rows are the most
 * that still find a pair at the threshold with the chance 1 - error.
 */
export function sizeLsh(workload: Workload): LshSizing {
  const miss = target(workload);
  let rows = 1;
  let bands = 1;
  if (workload.memoryBits !== undefined) {
    const k = Math.max(1, Math.floor(workload.memoryBits / VALUE_BITS));
    for (let r = 1; r <= k; r++) {
      if (lshChance(LSH_THRESHOLD, r, Math.floor(k / r)) >= 1 - miss) rows = r;
      else break;
    }
    bands = Math.floor(k / rows);
  } else {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 1; r <= 24; r++) {
      const b = Math.max(1, Math.ceil(Math.log(miss) / Math.log(1 - LSH_THRESHOLD ** r)));
      const alarm = lshChance(LSH_FAR, r, b);
      if (alarm < best - 1e-12) {
        best = alarm;
        rows = r;
        bands = b;
      }
    }
  }
  const k = rows * bands;
  const recall = lshChance(LSH_THRESHOLD, rows, bands);
  return { k, rows, bands, recall, falseAlarm: lshChance(LSH_FAR, rows, bands), memoryBits: k * VALUE_BITS, meetsTarget: workload.error === undefined || recall >= 1 - workload.error };
}

/** The bits of a HyperMinHash register: 5 for the position of the first one bit and 3 of mantissa, as in the game. */
export const HYPERMINHASH_REGISTER_BITS = 8;

export interface HyperMinHashSizing extends Sized {
  indexBits: number;
  registers: number;
  /** About the most the standard error of an estimated similarity can be: 1 / (2 sqrt(registers)). */
  standardError: number;
}

/** HyperMinHash: registers of 8 bits, a power of two of them; the standard error is about 1 / (2 sqrt(registers)), so registers = 2^ceil(log2(1 / (4 error^2))). */
export function sizeHyperMinHash(workload: Workload): HyperMinHashSizing {
  const indexBits = Math.max(4, workload.memoryBits !== undefined ? Math.floor(Math.log2(workload.memoryBits / HYPERMINHASH_REGISTER_BITS)) : Math.ceil(Math.log2(1 / (4 * target(workload) ** 2))));
  const registers = 2 ** indexBits;
  const standardError = 1 / (2 * Math.sqrt(registers));
  return { indexBits, registers, standardError, memoryBits: registers * HYPERMINHASH_REGISTER_BITS, meetsTarget: meets(workload, standardError) };
}
