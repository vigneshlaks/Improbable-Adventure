import { murmur3U32 } from "../hash/murmur3";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  COUNTER_BITS,
  DEFAULT_HASH_SEED,
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

const COUNTER_MAX = 2 ** COUNTER_BITS - 1;

/**
 * Count-Min Sketch: a grid of 32-bit counters (depth rows by width columns), sized from Space.
 * Knob: depth. It never underestimates a live value; it can only overshoot, by at most about
 * (e / width) * N, where N is the number of live values. Deletes decrement counters and stop at zero.
 *
 * With the Steady enchantment it is Count-Min with Conservative Update: an insert raises only the counters that
 * sit at the value's current minimum, so cells shared with other values are inflated far less and the estimate
 * overshoots much less (it still never underestimates). The price is that deletes cannot be undone, so they are
 * counted and only widen the range, and the grid is built from Space / (1 + the Steady cost).
 *
 * Each row uses its own seeded hash so rows collide independently. Deriving the rows from double
 * hashing made them collide together (see notes/dev).
 */
export class CountMinSketch implements Structure {
  readonly kind = "countMinSketch" as const;
  readonly params: Readonly<Record<string, number>>;

  private counters: Uint32Array;
  private total = 0;
  private deleteCount = 0;
  private readonly conservative: boolean;
  private readonly width: number;
  private readonly depth: number;
  private readonly seed: number;
  private readonly rowSeeds: number[];

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.depth = Math.max(1, Math.floor(options.knob ?? constants.cmsDefaultDepth));
    this.conservative = options.enchantment === STEADY;
    const gridBits = this.conservative ? steadySpace(options.spaceBits, constants.steadySpaceCost) : options.spaceBits;
    assertSpace("countMinSketch", gridBits, COUNTER_BITS * this.depth);
    this.width = Math.floor(gridBits / (COUNTER_BITS * this.depth));
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.rowSeeds = Array.from({ length: this.depth }, (_, row) => murmur3U32(row, this.seed));
    this.counters = new Uint32Array(this.width * this.depth);
    this.params = { width: this.width, depth: this.depth };
  }

  spaceBits(): number {
    const grid = COUNTER_BITS * this.width * this.depth;
    return this.conservative ? Math.min(this.options.spaceBits, Math.ceil(grid * (1 + this.constants.steadySpaceCost))) : grid;
  }

  /** Live total N: inserts minus deletes. A conservative sketch cannot take deletes back, so for it this is all the inserts. */
  get liveTotal(): number {
    return this.total;
  }

  /** Inserts seen (a plain sketch has taken its deletes back out of this). */
  get inserts(): number {
    return this.total;
  }

  /** Deletes seen and, in a conservative sketch, left in the counters. */
  get deletes(): number {
    return this.deleteCount;
  }

  /** Chance the overshoot bound holds for one query: 1 - e^(-depth). */
  get bandConfidence(): number {
    return 1 - Math.exp(-this.depth);
  }

  /** How far an estimate is likely to overshoot: (e / width) * N. */
  get errorBand(): number {
    return (Math.E / this.width) * this.total;
  }

  private slots(value: number): number[] {
    const out: number[] = [];
    for (let row = 0; row < this.depth; row++) {
      out.push(row * this.width + (murmur3U32(value, this.rowSeeds[row] ?? 0) % this.width));
    }
    return out;
  }

  estimate(value: number): number {
    let best = COUNTER_MAX;
    for (const slot of this.slots(value)) best = Math.min(best, this.counters[slot] ?? 0);
    return best;
  }

  ingest(event: StreamEvent): void {
    const slots = this.slots(event.value);
    if (this.conservative) {
      if (event.op === "delete") {
        this.deleteCount++; // raising only the smallest counters cannot be undone, so the departure is only counted
        return;
      }
      const raised = this.estimate(event.value) + 1;
      for (const slot of slots) if ((this.counters[slot] ?? 0) < raised) this.counters[slot] = Math.min(COUNTER_MAX, raised);
      this.total++;
      return;
    }
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
    // A conservative sketch leaves deleted units in its counters, so the live count can be that many lower.
    return {
      estimate: est,
      low: Math.max(0, est - this.errorBand - (this.conservative ? this.deleteCount : 0)),
      high: est, // one-sided: never underestimates
      confidence: this.bandConfidence,
    };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { counters: Array.from(this.counters), total: this.total, ...(this.conservative ? { deletes: this.deleteCount } : {}) },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): CountMinSketch {
    expectKind(snapshot, "countMinSketch");
    const sketch = new CountMinSketch(optionsFromSnapshot(snapshot), constants);
    sketch.counters = Uint32Array.from(readCounts(snapshot.state, "counters", sketch.counters.length));
    sketch.total = readNumber(snapshot.state, "total");
    if (sketch.conservative) sketch.deleteCount = readNumber(snapshot.state, "deletes");
    return sketch;
  }

  clone(): CountMinSketch {
    const copy = new CountMinSketch(this.options, this.constants);
    copy.counters = new Uint32Array(this.counters);
    copy.total = this.total;
    copy.deleteCount = this.deleteCount;
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
    merged.deleteCount = this.deleteCount + other.deleteCount;
    return merged;
  }
}
