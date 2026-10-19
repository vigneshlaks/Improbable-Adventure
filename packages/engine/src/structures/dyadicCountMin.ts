import { CountMinSketch } from "./countMinSketch";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  COUNTER_BITS,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Json,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** The depth of the Count-Min sketch of a level when the player gives none. */
const DEFAULT_DEPTH = 3;
/** The least width a level's Count-Min sketch may have. */
const MIN_WIDTH = 4;

/**
 * Dyadic Count-Min (Cormode and Muthukrishnan): quantiles from Count-Min sketches. A value is cut to its top `dyadicBits` bits, giving
 * 2^bits buckets in order. Level j keeps a count for every aligned run of 2^j buckets (the dyadic intervals), so any prefix of the buckets
 * is a sum of at most `bits` of those counts, and a quantile is found by walking down from the whole range, going left when the target
 * falls in the left half. A level with few intervals (at most `dyadicExactMax`) is kept in exact counters; the levels below are Count-Min
 * sketches that share the rest of the Space. The counts only overestimate, so the walk finds a bucket at or below the true one, and the
 * sum of the sketches' error bands says how far above it can be.
 *
 * Values closer than a bucket are not told apart: it answers with the bucket's edges (a bucket is 2^(32 - bits) values wide).
 * It takes deletes back exactly, as a plain Count-Min does.
 */
export class DyadicCountMin implements Structure {
  readonly kind = "dyadicCountMin" as const;
  readonly params: Readonly<Record<string, number>>;

  /** Level j (0 = single buckets) as exact counters, or null when it is a sketch. */
  private exact: Array<Uint32Array | null> = [];
  private sketches: Array<CountMinSketch | null> = [];
  private readonly bits: number;
  private readonly depth: number;
  private readonly width: number;
  private total = 0;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.bits = constants.dyadicBits;
    this.depth = Math.max(1, Math.floor(options.knob ?? DEFAULT_DEPTH));
    // The top levels have few intervals and are exact. The rest are sketches sharing what is left.
    const levels = Array.from({ length: this.bits }, (_, j) => j); // level `bits` is the total, kept as a number
    const isExact = (j: number) => 2 ** (this.bits - j) <= constants.dyadicExactMax;
    const exactBits = levels.filter(isExact).reduce((sum, j) => sum + 2 ** (this.bits - j) * constants.dyadicExactCounterBits, 0);
    const sketchLevels = levels.filter((j) => !isExact(j));
    assertSpace("dyadicCountMin", options.spaceBits, exactBits + sketchLevels.length * MIN_WIDTH * this.depth * COUNTER_BITS);
    this.width = sketchLevels.length === 0 ? 0 : Math.floor((options.spaceBits - exactBits) / (sketchLevels.length * this.depth * COUNTER_BITS));
    for (const j of levels) {
      if (isExact(j)) {
        this.exact[j] = new Uint32Array(2 ** (this.bits - j));
        this.sketches[j] = null;
      } else {
        this.exact[j] = null;
        this.sketches[j] = new CountMinSketch(
          { spaceBits: this.width * this.depth * COUNTER_BITS, knob: this.depth, hashSeed: ((options.hashSeed ?? DEFAULT_HASH_SEED) + Math.imul(j + 1, 0x9e3779b1)) >>> 0 },
          constants,
        );
      }
    }
    this.params = { buckets: 2 ** this.bits, sketchLevels: sketchLevels.length, width: this.width, depth: this.depth, exactLevels: this.bits - sketchLevels.length };
  }

  spaceBits(): number {
    let bits = 0;
    for (const level of this.exact) if (level) bits += level.length * this.constants.dyadicExactCounterBits;
    for (const sketch of this.sketches) if (sketch) bits += sketch.spaceBits();
    return bits;
  }

  /** Live units: inserts minus deletes. */
  get liveTotal(): number {
    return this.total;
  }

  /** The width of one bucket, in values. */
  get bucketWidth(): number {
    return 2 ** (32 - this.bits);
  }

  private bucket(value: number): number {
    return value >>> (32 - this.bits);
  }

  ingest(event: StreamEvent): void {
    const bucket = this.bucket(event.value);
    const insert = event.op === "insert";
    if (!insert && this.total === 0) return;
    for (let j = 0; j < this.bits; j++) {
      const key = bucket >>> j;
      const level = this.exact[j];
      if (level) {
        const c = level[key] ?? 0;
        if (insert) level[key] = c + 1;
        else if (c > 0) level[key] = c - 1;
      } else (this.sketches[j] as CountMinSketch).ingest({ op: event.op, value: key });
    }
    this.total += insert ? 1 : -1;
  }

  /** The count of the aligned run of 2^level buckets that starts at bucket `key << level`: exact above, an overestimate in a sketch. */
  private count(level: number, key: number): number {
    if (level === this.bits) return this.total;
    const exact = this.exact[level];
    return exact ? (exact[key] ?? 0) : (this.sketches[level] as CountMinSketch).estimate(key);
  }

  /** The count of every bucket in order, as the structure holds it (an overestimate where the buckets are in a sketch). */
  bucketCounts(): number[] {
    return Array.from({ length: 2 ** this.bits }, (_, bucket) => this.count(0, bucket));
  }

  /** The sum of what the sketches may overshoot by, expected: the band `e N / width` of each. */
  get errorBand(): number {
    let band = 0;
    for (const sketch of this.sketches) if (sketch) band += sketch.errorBand;
    return band;
  }

  /** The chance all the sketches' bands hold at once. */
  get bandConfidence(): number {
    let confidence = 1;
    for (const sketch of this.sketches) if (sketch) confidence *= sketch.bandConfidence;
    return confidence;
  }

  /** The bucket that holds the unit at `target` (counting from 1) when the units are in order, as far as the counts say. */
  private bucketAt(target: number): number {
    let key = 0;
    let remaining = Math.max(1, Math.ceil(target));
    for (let level = this.bits; level > 0; level--) {
      const left = Math.min(this.count(level - 1, key * 2), this.count(level, key));
      if (remaining <= left) key = key * 2;
      else {
        remaining -= left;
        key = key * 2 + 1;
      }
    }
    return key;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "rank") return null;
    const confidence = this.bandConfidence;
    if (this.total <= 0) return { estimate: 0, low: 0, high: Number.POSITIVE_INFINITY, confidence };
    const target = challenge.quantile * this.total;
    const found = this.bucketAt(target);
    // The counts only overshoot, so a bucket whose counted prefix reaches target + band has a true prefix that reaches the target. Past the
    // total there is no such bucket: the structure cannot say how high the quantile is.
    const bound = target + this.errorBand;
    const above = bound <= this.total ? this.bucketAt(bound) : null;
    return {
      estimate: (found + 1) * this.bucketWidth - 1,
      low: found * this.bucketWidth,
      high: above === null ? Number.POSITIVE_INFINITY : (above + 1) * this.bucketWidth - 1,
      confidence,
    };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: {
        exact: this.exact.map((level) => (level ? Array.from(level) : [])) as Json,
        sketches: this.sketches.map((sketch) => (sketch ? (sketch.snapshot() as unknown as Json) : null)) as Json,
        total: this.total,
      },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): DyadicCountMin {
    expectKind(snapshot, "dyadicCountMin");
    const dyadic = new DyadicCountMin(optionsFromSnapshot(snapshot), constants);
    const exact = snapshot.state.exact;
    const sketches = snapshot.state.sketches;
    if (!Array.isArray(exact) || !Array.isArray(sketches) || exact.length !== dyadic.bits || sketches.length !== dyadic.bits) throw new RangeError('Bad snapshot: "exact" and "sketches" need one entry per level');
    for (let j = 0; j < dyadic.bits; j++) {
      const level = dyadic.exact[j];
      if (level) dyadic.exact[j] = Uint32Array.from(readCounts({ level: exact[j] as Json }, "level", level.length));
      else {
        const sketch = sketches[j];
        if (!sketch || typeof sketch !== "object" || Array.isArray(sketch)) throw new RangeError('Bad snapshot: a sketch level needs its snapshot');
        dyadic.sketches[j] = CountMinSketch.fromSnapshot(sketch as unknown as StructureSnapshot, constants);
      }
    }
    dyadic.total = readNumber(snapshot.state, "total");
    return dyadic;
  }

  clone(): DyadicCountMin {
    const copy = new DyadicCountMin(this.options, this.constants);
    copy.exact = this.exact.map((level) => (level ? new Uint32Array(level) : null));
    copy.sketches = this.sketches.map((sketch) => (sketch ? sketch.clone() : null));
    copy.total = this.total;
    return copy;
  }
}
