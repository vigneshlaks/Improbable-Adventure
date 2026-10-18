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
