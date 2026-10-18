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
