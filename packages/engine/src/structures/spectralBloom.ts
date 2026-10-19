import { doubleHashIndices } from "../hash/doubleHash";
import { bloomOptimalK, DEFAULT_BITS_PER_ITEM } from "./bloomFilter";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";
import { binomialUpper } from "../stats/stats";

/** The fewest counters worth having. */
const MIN_COUNTERS = 16;

/**
 * Spectral Bloom Filter (Cohen and Matias): a Bloom filter whose bits are counters. A value adds one to each of its k counters, and
 * takes one off each when deleted, so unlike a Bloom filter it handles deletes. It answers two questions from one array:
 * Presence (every one of the value's counters is above zero) and Frequency (the smallest of them, which is never below the truth,
 * as in Count-Min). All k counters share one array, so the counters are m = Space / counter bits, and k comes from the expected item count as for a
 * Bloom filter. A counter stops at its largest value, after which it only says "at least".
 */
export class SpectralBloom implements Structure {
  readonly kind = "spectralBloom" as const;
  readonly params: Readonly<Record<string, number>>;

  private counters: Uint32Array;
  private total = 0;
  private readonly m: number;
  private readonly k: number;
  private readonly seed: number;
  private readonly max: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    const bits = constants.spectralCounterBits;
    assertSpace("spectralBloom", options.spaceBits, bits * MIN_COUNTERS);
    this.m = Math.floor(options.spaceBits / bits);
    const n = Math.max(1, Math.floor(options.knob ?? this.m / (DEFAULT_BITS_PER_ITEM / 2)));
    this.k = bloomOptimalK(this.m, n);
    this.max = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.counters = new Uint32Array(this.m);
    this.params = { counters: this.m, k: this.k, expectedItems: n };
  }

  spaceBits(): number {
    return this.m * this.constants.spectralCounterBits;
  }

  /** Live units: inserts minus deletes. */
  get liveTotal(): number {
    return this.total;
  }

  private slots(value: number): number[] {
    return doubleHashIndices(value, this.k, this.m, this.seed);
  }

  /** The smallest of a value's counters: the Frequency estimate, never below the truth unless a counter stopped. */
  estimate(value: number): number {
    let best = this.max;
    for (const slot of this.slots(value)) best = Math.min(best, this.counters[slot] ?? 0);
    return best;
  }

  /** How far an estimate is likely to overshoot: the counters share one array, so a value's counter holds on average k N / m units of others; the band is e times that. */
  get errorBand(): number {
    return (Math.E * this.k * this.total) / this.m;
  }

  /** Chance the band holds for one query, as for Count-Min: 1 - e^(-k). */
  get bandConfidence(): number {
    return 1 - Math.exp(-this.k);
  }

  /** False-positive rate for a value never inserted, from the share of counters in use. */
  get falsePositiveRate(): number {
    let used = 0;
    for (const c of this.counters) if (c > 0) used++;
    return (used / this.m) ** this.k;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "insert") {
      for (const slot of this.slots(event.value)) {
        const c = this.counters[slot] ?? 0;
        if (c < this.max) this.counters[slot] = c + 1;
      }
      this.total++;
      return;
    }
    for (const slot of this.slots(event.value)) {
      const c = this.counters[slot] ?? 0;
      if (c > 0 && c < this.max) this.counters[slot] = c - 1; // a counter that has stopped is no longer reliable, so it is left alone
    }
    if (this.total > 0) this.total--;
  }

  query(challenge: Challenge): Answer | null {
    const confidence = this.constants.confidence;
    if (challenge.kind === "presence") {
      const flagged = challenge.targets.filter((t) => this.slots(t).every((slot) => (this.counters[slot] ?? 0) > 0));
      const maxFalse = binomialUpper(challenge.targets.length, this.falsePositiveRate, confidence);
      return { estimate: flagged, low: Math.max(0, flagged.length - maxFalse), high: flagged.length, confidence };
    }
    if (challenge.kind !== "frequency") return null;
    const est = this.estimate(challenge.value);
    return {
      estimate: est,
      low: Math.max(0, est - this.errorBand),
      high: est >= this.max ? Number.POSITIVE_INFINITY : est, // one-sided: never underestimates, unless a counter stopped
      confidence: this.bandConfidence,
    };
  }

  snapshot(): StructureSnapshot {
    return { ...snapshotHeader(this.kind, this.options), state: { counters: Array.from(this.counters), total: this.total } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): SpectralBloom {
    expectKind(snapshot, "spectralBloom");
    const filter = new SpectralBloom(optionsFromSnapshot(snapshot), constants);
    filter.counters = Uint32Array.from(readCounts(snapshot.state, "counters", filter.counters.length));
    filter.total = readNumber(snapshot.state, "total");
    return filter;
  }

  clone(): SpectralBloom {
    const copy = new SpectralBloom(this.options, this.constants);
    copy.counters = new Uint32Array(this.counters);
    copy.total = this.total;
    return copy;
  }
}
