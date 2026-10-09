import { murmur3U32 } from "../hash/murmur3";
import { zForConfidence } from "../stats/stats";
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
} from "./types";

/** Smallest register count that still behaves like LogLog rather than noise. */
export const MIN_LOGLOG_REGISTERS = 16;

/** Asymptotic LogLog bias constant (Durand & Flajolet). */
const ALPHA_INFINITY = 0.39701;

/** Relative standard error is LOGLOG_ERROR_COEFFICIENT / sqrt(m). */
export const LOGLOG_ERROR_COEFFICIENT = 1.3;

const MAX_REGISTER = 2 ** LOGLOG_REGISTER_BITS - 1;

/** Finite-m bias correction, alpha_m ~ alpha_inf - (2 pi^2 + ln^2 2) / (48 m). */
function alphaFor(m: number): number {
  return ALPHA_INFINITY - (2 * Math.PI * Math.PI + Math.LN2 * Math.LN2) / (48 * m);
}

/**
 * LogLog counter: m = 2^b five-bit registers (m is the largest power of two with 5m <= Space).
 * Each register keeps the longest run of leading zeros seen among values routed to it.
 * Relative standard error is about 1.30 / sqrt(m), valid once the stream holds many times m distinct values;
 * small streams are biased, which is the structure's weakness. Cannot delete.
 */
export class LogLog implements Structure {
  readonly kind = "logLog" as const;
  readonly params: Readonly<Record<string, number>>;

  private registers: Uint8Array;
  private readonly b: number;
  private readonly m: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("logLog", options.spaceBits, LOGLOG_REGISTER_BITS * MIN_LOGLOG_REGISTERS);
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
    return LOGLOG_ERROR_COEFFICIENT / Math.sqrt(this.m);
  }

  ingest(event: StreamEvent): void {
    if (event.op !== "insert") return; // LogLog cannot delete
    const h = murmur3U32(event.value, this.seed);
    const idx = h >>> (32 - this.b);
    const rest = (h << this.b) >>> 0;
    const rank = Math.min(MAX_REGISTER, rest === 0 ? 33 - this.b : Math.clz32(rest) + 1);
    if (rank > (this.registers[idx] ?? 0)) this.registers[idx] = rank;
  }

  estimate(): number {
    let sum = 0;
    for (const r of this.registers) sum += r;
    return alphaFor(this.m) * this.m * Math.pow(2, sum / this.m);
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "count") return null;
    const est = this.estimate();
    // The estimate is 2 raised to an almost-normal average, so est / n is close to lognormal with mean 1
    // and relative standard deviation 1.30 / sqrt(m). A symmetric est +/- z*sigma interval under-covers
    // when sigma is large (small m); inverting the lognormal quantiles keeps the stated confidence.
    const sigmaLn = Math.sqrt(Math.log(1 + this.standardError ** 2));
    const centre = (sigmaLn * sigmaLn) / 2;
    const z = zForConfidence(this.constants.confidence);
    return {
      estimate: est,
      low: est * Math.exp(centre - z * sigmaLn),
      high: est * Math.exp(centre + z * sigmaLn),
      confidence: this.constants.confidence,
    };
  }

  clone(): LogLog {
    const copy = new LogLog(this.options, this.constants);
    copy.registers = new Uint8Array(this.registers);
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
    return merged;
  }
}
