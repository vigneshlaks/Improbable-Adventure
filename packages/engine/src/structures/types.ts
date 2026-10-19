import { PUBLIC_HASH_SEED } from "../hash/doubleHash";
import type { Rng } from "../rng/rng";

/** Every structure the engine can build. */
export const STRUCTURE_KINDS = [
  "exactMemory",
  "reservoirSampling",
  "bloomFilter",
  "countMinSketch",
  "logLog",
  "linearCounting",
  "hyperLogLog",
  "countSketch",
  "topKTracker",
  "cuckooFilter",
  "kMinimumValues",
  "kllSketch",
  "tDigest",
  "minHash",
  "scalableBloom",
  "spectralBloom",
  "dyadicCountMin",
  "quotientFilter",
  "simHash",
  "lsh",
  "hyperMinHash",
] as const;

export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export interface StreamEvent {
  op: "insert" | "delete";
  value: number; // uint32
}

/**
 * What a structure can be asked. Presence and Count take no player input beyond the targets;
 * Frequency names the value whose count is wanted (the enemy's shielded value).
 */
export type Challenge =
  | { kind: "presence"; targets: number[] }
  | { kind: "frequency"; value: number }
  | { kind: "count" }
  | { kind: "rank"; quantile: number }
  /**
   * Copies of sets of values, to be told apart by how like the stream's live set each is. `targets` names the copies 0, 1, 2, ... so a
   * flagged subset reads as in Presence. A copy is real if its Jaccard similarity to the live set is at least `threshold`.
   */
  | { kind: "likeness"; targets: number[]; copies: number[][]; threshold: number };

export interface Answer {
  /** A number, or the flagged subset of targets for presence questions. */
  estimate: number | number[];
  /** Lower and upper bound at `confidence`. One-sided structures have a bound equal to the estimate. */
  low: number;
  high: number;
  confidence: number;
}

/**
 * Values injected from content/balance.json. The engine imports no other package,
 * so whoever builds a run passes these in.
 */
export interface StructureConstants {
  /** Bits paid per raw stored value (VALUE_BITS). */
  valueBits: number;
  /** Default confidence level for answer bounds. */
  confidence: number;
  /** Count-Min rows used when the player does not choose a depth. */
  cmsDefaultDepth: number;
  /** LogLog relative error is this divided by sqrt(register count). */
  logLogErrorCoefficient: number;
  /** HyperLogLog relative error is this divided by sqrt(register count). */
  hyperLogLogErrorCoefficient: number;
  /** HyperLogLog counts empty registers instead while that count is below this multiple of the register count. */
  hyperLogLogSmallRange: number;
  /** The extra share of Space a Steady structure costs for the same grid of counters or registers. */
  steadySpaceCost: number;
  /** SuperLogLog (LogLog with Steady) relative error is this divided by sqrt(register count). */
  superLogLogErrorCoefficient: number;
  /** Bits in one cell of a Stable Bloom Filter (a Bloom Filter with Fading). Its cells count from 0 to 2^bits - 1. */
  fadingCellBits: number;
  /** The window a Stable Bloom Filter remembers when the player gives none, as a multiple of its cell count (in values). */
  fadingWindow: number;
  /** Bits in one Count-Min counter with the Light enchantment. Such a counter stops at 2^bits - 1. */
  lightCounterBits: number;
  /** Bits in one HyperLogLog register with the Light enchantment. Such a register stops at rank 2^bits - 1. */
  lightRegisterBits: number;
  /** Count Sketch rows when the player does not choose a depth. An odd number, so the median is one of the rows' estimates. */
  countSketchDefaultDepth: number;
  /** The share of a Top-K Tracker's Space that holds its exact candidate list; the rest is its Count-Min grid. */
  topKShare: number;
  /** Fingerprints a Cuckoo Filter bucket holds. */
  cuckooBucketSize: number;
  /** Bits in a Cuckoo Filter fingerprint when the player does not choose. */
  cuckooFingerprintBits: number;
  /** How many fingerprints an insert may push aside before the Cuckoo Filter gives up and drops one. */
  cuckooMaxKicks: number;
  /** A KLL sketch's rank error, as a share of the units, is this divided by its k (calibrated by simulation). */
  kllRankError: number;
  /** A t-digest's rank error at quantile q, as a share of the units, is this times sqrt(q (1 - q)) over its compression (calibrated by simulation). */
  tdigestRankError: number;
  /** A Scalable Bloom Filter: the share of its Space its first layer gets, the false-positive target of that layer, and the factor each later layer tightens it by. */
  scalableBloomFirstShare: number;
  scalableBloomTarget: number;
  scalableBloomTightening: number;
  /** Bits of each counter of a Spectral Bloom Filter. */
  spectralCounterBits: number;
  /** A Dyadic Count-Min: the bits of a value it keeps (so 2^bits buckets), the most intervals a level may have and still be counted exactly, and the bits of an exact counter. */
  dyadicBits: number;
  dyadicExactMax: number;
  dyadicExactCounterBits: number;
  /** The remainder bits of a Quotient Filter when the player gives none. */
  quotientRemainderBits: number;
  /** The bits of each counter of a SimHash. */
  simHashCounterBits: number;
  /** The mantissa bits a HyperMinHash register keeps beside the position of the first one bit. */
  hyperMinHashMantissaBits: number;
  /** The chance a copy exactly at the threshold must have of being flagged by a locality-sensitive hash, which sets how many rows a band has. */
  lshRecall: number;
}

/** Anything that survives JSON.stringify and JSON.parse unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A plain-data copy of a structure: its kind, the options it was built with, and its contents.
 * `restoreStructure` rebuilds an identical live structure from it.
 */
export interface StructureSnapshot {
  kind: StructureKind;
  spaceBits: number;
  knob?: number;
  hashSeed?: number;
  /** The enchantment the structure was built with, if any. */
  enchantment?: string;
  state: { [key: string]: Json };
}

export interface Structure {
  readonly kind: StructureKind;
  readonly params: Readonly<Record<string, number>>;
  spaceBits(): number;
  ingest(event: StreamEvent): void;
  /** null means this structure cannot answer this kind of challenge. */
  query(challenge: Challenge): Answer | null;
  clone(): Structure;
  /** Plain-data copy of this structure, safe to store as JSON. */
  snapshot(): StructureSnapshot;
  merge?(other: Structure): Structure;
}

export interface StructureOptions {
  /** Space the player assigned, in bits. */
  spaceBits: number;
  /** The one optional extra knob; its meaning depends on the structure. */
  knob?: number;
  /** Hash seed. Defaults to the public seed that Cunning enemies can attack. */
  hashSeed?: number;
  /** Randomness source, required by structures that sample (Reservoir Sampling). */
  rng?: Rng;
  /** The enchantment attached to this kind of structure (see the run), if any. It can change how the structure behaves. */
  enchantment?: string;
}

export const DEFAULT_HASH_SEED = PUBLIC_HASH_SEED;

/** Bits in one counter in a counter-based structure. Fixed by the spec's Space cost formulas. */
export const COUNTER_BITS = 32;

/** Bits in one LogLog register. */
export const LOGLOG_REGISTER_BITS = 5;

/** The enchantment that makes a Count-Min Sketch conservative and a LogLog a SuperLogLog, for 10 percent more Space. */
export const STEADY = "steady";

/** The enchantment that narrows Count-Min counters and HyperLogLog registers: more of them in the same Space, but they can fill up. */
export const LIGHT = "light";

/** The enchantment that makes a Bloom Filter a Stable Bloom Filter: its cells fade, so it forgets old values. */
export const FADING = "fading";

/** The Space a Steady structure builds its grid from: the Space it was given, less the cost of being Steady. */
export function steadySpace(spaceBits: number, steadyCost: number): number {
  return Math.floor(spaceBits / (1 + steadyCost));
}

export function assertSpace(kind: StructureKind, spaceBits: number, minBits: number): void {
  if (!Number.isInteger(spaceBits) || spaceBits < minBits) {
    throw new RangeError(`${kind} needs an integer Space of at least ${minBits} bits, got ${spaceBits}`);
  }
}
