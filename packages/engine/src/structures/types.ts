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
  | { kind: "count" };

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
