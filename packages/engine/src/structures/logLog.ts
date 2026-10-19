import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
import { liveCountRange, type CountRange } from "./ghosts";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  LOGLOG_REGISTER_BITS,
  STEADY,
  steadySpace,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** Fewest registers that still behave like LogLog rather than noise. */
export const MIN_LOGLOG_REGISTERS = 16;

/** Bias-correction constant for large register counts (Durand & Flajolet). */
const ALPHA_INFINITY = 0.39701;

const MAX_REGISTER = 2 ** LOGLOG_REGISTER_BITS - 1;

/** SuperLogLog averages only this share of the registers, the smallest, and throws the lucky outliers away. */
const KEPT_SHARE = 0.7;

/**
 * SuperLogLog's bias correction, for the estimate `m0 * 2^(mean of the m0 smallest registers)`. Calibrated by simulation
 * (the published asymptotic constant is 0.7735 / 0.7, about 1.105, and the finite-size values here run from 1.09 to 1.13).
 */
const SUPERLOGLOG_ALPHA = 1.1;

/** The bias correction adjusted for the actual register count. */
function alphaFor(m: number): number {
  return ALPHA_INFINITY - (2 * Math.PI * Math.PI + Math.LN2 * Math.LN2) / (48 * m);
}

/**
 * LogLog counter: m five-bit registers, where m is the largest power of two that fits in Space.
 * Each register remembers the rarest hash pattern (longest run of leading zeros) among the values routed to it.
 * Accurate on large streams, biased on small ones. With the Steady enchantment it is a SuperLogLog: it averages only the
 * smallest 70 percent of the registers, which cuts the standard error from 1.30 / sqrt(m) to about 1.05 / sqrt(m), and it
 * is built from Space / (1 + the Steady cost). Cannot delete, so it counts values that were deleted since
 * (ghosts). It counts the inserts and deletes it sees and lowers its range's low bound by the ghosts they allow.
 */
export class LogLog implements Structure {
  readonly kind = "logLog" as const;
  readonly params: Readonly<Record<string, number>>;

  private registers: Uint8Array;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly truncated: boolean;
  private readonly b: number;
  private readonly m: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.truncated = options.enchantment === STEADY;
    const registerBits = this.truncated ? steadySpace(options.spaceBits, constants.steadySpaceCost) : options.spaceBits;
    assertSpace("logLog", registerBits, LOGLOG_REGISTER_BITS * MIN_LOGLOG_REGISTERS);
    this.b = Math.floor(Math.log2(registerBits / LOGLOG_REGISTER_BITS));
    this.m = 2 ** this.b;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.registers = new Uint8Array(this.m);
    this.params = { registers: this.m, indexBits: this.b };
  }

  spaceBits(): number {
    const registers = LOGLOG_REGISTER_BITS * this.m;
    return this.truncated ? Math.min(this.options.spaceBits, Math.ceil(registers * (1 + this.constants.steadySpaceCost))) : registers;
  }

  /** Relative standard error predicted by theory. */
  get standardError(): number {
    const coefficient = this.truncated ? this.constants.superLogLogErrorCoefficient : this.constants.logLogErrorCoefficient;
    return coefficient / Math.sqrt(this.m);
  }

  /** Insert events seen. */
  get inserts(): number {
    return this.insertCount;
  }

  /** Delete events seen and ignored. Each ghost needs at least one, so there are never more ghosts than this. */
  get deletes(): number {
    return this.deleteCount;
  }

  /** The register a value goes to and the rank it would leave there, with what the register holds now: what an enemy that knows the hashes can read. */
  probe(value: number): { register: number; rank: number; held: number } {
    const h = murmur3U32(value, this.seed);
    const idx = h >>> (32 - this.b);
    const rest = (h << this.b) >>> 0;
    const rank = Math.min(MAX_REGISTER, rest === 0 ? 33 - this.b : Math.clz32(rest) + 1);
    return { register: idx, rank, held: this.registers[idx] ?? 0 };
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // it cannot undo a register, but it can count the departure
      return;
    }
    this.insertCount++;
    const h = murmur3U32(event.value, this.seed);
    const idx = h >>> (32 - this.b);
    const rest = (h << this.b) >>> 0;
    const rank = Math.min(MAX_REGISTER, rest === 0 ? 33 - this.b : Math.clz32(rest) + 1);
    if (rank > (this.registers[idx] ?? 0)) this.registers[idx] = rank;
  }

  estimate(): number {
    if (this.truncated) {
      const kept = Math.floor(KEPT_SHARE * this.m);
      const smallest = Array.from(this.registers).sort((a, b) => a - b).slice(0, kept);
      let sum = 0;
      for (const r of smallest) sum += r;
      return SUPERLOGLOG_ALPHA * kept * Math.pow(2, sum / kept);
    }
    let sum = 0;
    for (const r of this.registers) sum += r;
    return alphaFor(this.m) * this.m * Math.pow(2, sum / this.m);
  }

  /** The range for the distinct values ever inserted, at a two-sided confidence. */
  private everRange(confidence: number): CountRange {
    const est = this.estimate();
    // The error is skewed high, so a symmetric range under-covers at small register counts.
    // These bounds are lopsided (lognormal) to keep the stated confidence.
    const sigmaLn = Math.sqrt(Math.log(1 + this.standardError ** 2));
    const centre = (sigmaLn * sigmaLn) / 2;
    const z = zForConfidence(confidence);
    return { estimate: est, low: est * Math.exp(centre - z * sigmaLn), high: est * Math.exp(centre + z * sigmaLn) };
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "count") return null;
    const confidence = this.constants.confidence;
    return { ...liveCountRange((c) => this.everRange(c), this.insertCount, this.deleteCount, confidence), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { registers: Array.from(this.registers), inserts: this.insertCount, deletes: this.deleteCount },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): LogLog {
    expectKind(snapshot, "logLog");
    const counter = new LogLog(optionsFromSnapshot(snapshot), constants);
    counter.registers = Uint8Array.from(readCounts(snapshot.state, "registers", counter.registers.length));
    counter.insertCount = readNumber(snapshot.state, "inserts");
    counter.deleteCount = readNumber(snapshot.state, "deletes");
    return counter;
  }

  clone(): LogLog {
    const copy = new LogLog(this.options, this.constants);
    copy.registers = new Uint8Array(this.registers);
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }

  merge(other: Structure): LogLog {
    if (!(other instanceof LogLog) || other.m !== this.m || other.seed !== this.seed) {
      throw new Error("LogLog counters merge only with same-shaped, same-seeded counters");
    }
    const merged = this.clone();
    for (let i = 0; i < merged.registers.length; i++) {
      merged.registers[i] = Math.max(merged.registers[i] ?? 0, other.registers[i] ?? 0);
    }
    merged.insertCount = this.insertCount + other.insertCount;
    merged.deleteCount = this.deleteCount + other.deleteCount;
    return merged;
  }
}
