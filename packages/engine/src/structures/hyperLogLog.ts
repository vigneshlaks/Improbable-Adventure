import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
import { liveCountRange, type CountRange } from "./ghosts";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  LOGLOG_REGISTER_BITS,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** Fewest registers that still behave like HyperLogLog rather than noise. */
export const MIN_HLL_REGISTERS = 16;

const MAX_REGISTER = 2 ** LOGLOG_REGISTER_BITS - 1;

/** The bias correction of the harmonic mean (Flajolet et al.), which depends on the register count for small m. */
function alphaFor(m: number): number {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

/**
 * HyperLogLog counter: m five-bit registers, where m is the largest power of two that fits in Space. Each register
 * remembers the rarest hash pattern among the values routed to it; the harmonic mean of those patterns gives the count,
 * with relative standard error about 1.04 / sqrt(m). When many registers are still empty (a small stream) it counts the
 * empty registers instead, as Linear Counting does, because the harmonic mean is far too high there.
 * Cannot delete, so it counts values that were deleted since (ghosts), and lowers its range's low bound by the ghosts
 * the inserts and deletes it sees allow.
 */
export class HyperLogLog implements Structure {
  readonly kind = "hyperLogLog" as const;
  readonly params: Readonly<Record<string, number>>;

  private registers: Uint8Array;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly b: number;
  private readonly m: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("hyperLogLog", options.spaceBits, LOGLOG_REGISTER_BITS * MIN_HLL_REGISTERS);
    this.b = Math.floor(Math.log2(options.spaceBits / LOGLOG_REGISTER_BITS));
    this.m = 2 ** this.b;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.registers = new Uint8Array(this.m);
    this.params = { registers: this.m, indexBits: this.b };
  }

  spaceBits(): number {
    return LOGLOG_REGISTER_BITS * this.m;
  }

  /** Relative standard error predicted by theory. */
  get standardError(): number {
    return this.constants.hyperLogLogErrorCoefficient / Math.sqrt(this.m);
  }

  /** Insert events seen. */
  get inserts(): number {
    return this.insertCount;
  }

  /** Delete events seen and ignored. Each ghost needs at least one, so there are never more ghosts than this. */
  get deletes(): number {
    return this.deleteCount;
  }

  /** Registers no value has reached yet. */
  get emptyRegisters(): number {
    let empty = 0;
    for (const r of this.registers) if (r === 0) empty++;
    return empty;
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

  /** The harmonic-mean estimate, which is only sound once the stream is a few times larger than the register count. */
  rawEstimate(): number {
    let sum = 0;
    for (const r of this.registers) sum += 2 ** -r;
    return (alphaFor(this.m) * this.m * this.m) / sum;
  }

  /** The count from the empty registers; infinite when none is empty. */
  private emptyCountEstimate(): number {
    const empty = this.emptyRegisters;
    return empty === 0 ? Number.POSITIVE_INFINITY : this.m * Math.log(this.m / empty);
  }

  /** True while the estimate comes from counting empty registers (a small stream). */
  private get usesEmptyCount(): boolean {
    return this.emptyCountEstimate() <= this.constants.hyperLogLogSmallRange * this.m;
  }

  estimate(): number {
    return this.usesEmptyCount ? this.emptyCountEstimate() : this.rawEstimate();
  }

  /** The error of counting empty registers, relative to the count (the Linear Counting law). */
  private emptyCountError(count: number): number {
    const t = count / this.m;
    return Math.sqrt(this.m * (Math.exp(t) - t - 1)) / count;
  }

  /** The range for the distinct values ever inserted, at a two-sided confidence. */
  private everRange(confidence: number): CountRange {
    const est = this.estimate();
    if (est === 0) return { estimate: 0, low: 0, high: 0 };
    const relative = this.usesEmptyCount ? this.emptyCountError(est) : this.standardError;
    const half = zForConfidence(confidence) * relative * est;
    return { estimate: est, low: Math.max(0, est - half), high: est + half };
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

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): HyperLogLog {
    expectKind(snapshot, "hyperLogLog");
    const counter = new HyperLogLog(optionsFromSnapshot(snapshot), constants);
    counter.registers = Uint8Array.from(readCounts(snapshot.state, "registers", counter.registers.length));
    counter.insertCount = readNumber(snapshot.state, "inserts");
    counter.deleteCount = readNumber(snapshot.state, "deletes");
    return counter;
  }

  clone(): HyperLogLog {
    const copy = new HyperLogLog(this.options, this.constants);
    copy.registers = new Uint8Array(this.registers);
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }

  merge(other: Structure): HyperLogLog {
    if (!(other instanceof HyperLogLog) || other.m !== this.m || other.seed !== this.seed) {
      throw new Error("HyperLogLog counters merge only with same-shaped, same-seeded counters");
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
