import { hashPair, nthHash } from "../hash/doubleHash";
import {
  assertSpace,
  COUNTER_BITS,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
} from "./types";

/** Depth used when the player does not choose one. Failure probability is e^-4, about 1.8%. */
export const DEFAULT_CMS_DEPTH = 4;

const COUNTER_MAX = 2 ** COUNTER_BITS - 1;

/**
 * Count-Min Sketch: d rows of w 32-bit counters, w derived from Space. Knob: depth d.
 * Never underestimates a live value. With probability 1 - e^-d the overestimate is at most (e / w) * N,
 * where N is the live total. Deletes decrement counters and clamp at zero.
 */
export class CountMinSketch implements Structure {
  readonly kind = "countMinSketch" as const;
  readonly params: Readonly<Record<string, number>>;

  private counters: Uint32Array;
  private total = 0;
  private readonly width: number;
  private readonly depth: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.depth = Math.max(1, Math.floor(options.knob ?? DEFAULT_CMS_DEPTH));
    assertSpace("countMinSketch", options.spaceBits, COUNTER_BITS * this.depth);
    this.width = Math.floor(options.spaceBits / (COUNTER_BITS * this.depth));
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.counters = new Uint32Array(this.width * this.depth);
    this.params = { width: this.width, depth: this.depth };
  }

  spaceBits(): number {
    return COUNTER_BITS * this.width * this.depth;
  }

  /** Live total N: inserts minus honored deletes. */
  get liveTotal(): number {
    return this.total;
  }

  /** Probability that the overestimate bound holds for one query. */
  get bandConfidence(): number {
    return 1 - Math.exp(-this.depth);
  }

  /** The (e / w) * N overestimate band. */
  get errorBand(): number {
    return (Math.E / this.width) * this.total;
  }

  private slots(value: number): number[] {
    const pair = hashPair(value, this.seed);
    const out: number[] = [];
    for (let row = 0; row < this.depth; row++) out.push(row * this.width + nthHash(pair, row, this.width));
    return out;
  }

  estimate(value: number): number {
    let best = COUNTER_MAX;
    for (const slot of this.slots(value)) best = Math.min(best, this.counters[slot] ?? 0);
    return best;
  }

  ingest(event: StreamEvent): void {
    const slots = this.slots(event.value);
    if (event.op === "insert") {
      for (const slot of slots) {
        const c = this.counters[slot] ?? 0;
        if (c < COUNTER_MAX) this.counters[slot] = c + 1;
      }
      this.total++;
      return;
    }
    for (const slot of slots) {
      const c = this.counters[slot] ?? 0;
      if (c > 0) this.counters[slot] = c - 1;
    }
    if (this.total > 0) this.total--;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "frequency") return null;
    const est = this.estimate(challenge.value);
    return {
      estimate: est,
      low: Math.max(0, est - this.errorBand),
      high: est, // one-sided: never underestimates
      confidence: this.bandConfidence,
    };
  }

  clone(): CountMinSketch {
    const copy = new CountMinSketch(this.options, this.constants);
    copy.counters = new Uint32Array(this.counters);
    copy.total = this.total;
    return copy;
  }

  merge(other: Structure): CountMinSketch {
    if (
      !(other instanceof CountMinSketch) ||
      other.width !== this.width ||
      other.depth !== this.depth ||
      other.seed !== this.seed
    ) {
      throw new Error("Count-Min sketches merge only with same-shaped, same-seeded sketches");
    }
    const merged = this.clone();
    for (let i = 0; i < merged.counters.length; i++) {
      merged.counters[i] = Math.min(COUNTER_MAX, (merged.counters[i] ?? 0) + (other.counters[i] ?? 0));
    }
    merged.total = this.total + other.total;
    return merged;
  }
}
