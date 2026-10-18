import { CountMinSketch } from "./countMinSketch";
import { expectKind, optionsFromSnapshot, readCounts, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  COUNTER_BITS,
  type Answer,
  type Challenge,
  type Json,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** One value on the candidate list: the interval its live count lies in, which then moves by exactly one for each insert or delete. */
export interface Candidate {
  value: number;
  low: number;
  high: number;
}

/**
 * Top-K Tracker, the fusion of Count-Min Sketch and Exact Memory: a Count-Min grid ranks the values, and a short list of
 * the heaviest keeps an interval around each one's count, which is then maintained exactly.
 *
 * A value joins the list when its Count-Min estimate beats the weakest candidate's upper bound (or the list is not full). It
 * enters with the interval the grid gives at that moment: its estimate is an upper bound (the grid never underestimates), and
 * the estimate less the grid's error band is a lower bound that holds with the grid's confidence. After that every insert
 * raises both ends by one and every delete lowers both, so a value that entered early, while the stream was small and
 * the band narrow, keeps a narrow interval however big the stream grows. A heavy value enters early, so on a skewed
 * stream the heavy values are answered far more tightly than the plain grid could. A value not on the list is answered by the grid.
 *
 * Space: `topKShare` of it holds the list, at VALUE_BITS + 2 x 32 bits per entry (the value and the two ends); the
 * rest is the grid, with the Count-Min's depth as the knob.
 */
export class TopKTracker implements Structure {
  readonly kind = "topKTracker" as const;
  readonly params: Readonly<Record<string, number>>;

  private grid: CountMinSketch;
  private entries: Candidate[] = [];
  private readonly capacity: number;
  private readonly entryBits: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.entryBits = constants.valueBits + 2 * COUNTER_BITS;
    this.capacity = Math.floor((options.spaceBits * constants.topKShare) / this.entryBits);
    if (this.capacity < 1) assertSpace("topKTracker", options.spaceBits, Math.ceil(this.entryBits / constants.topKShare));
    const gridBits = options.spaceBits - this.capacity * this.entryBits;
    this.grid = new CountMinSketch({ spaceBits: gridBits, knob: options.knob, hashSeed: options.hashSeed }, constants);
    this.params = { ...this.grid.params, candidates: this.capacity };
  }

  spaceBits(): number {
    return this.grid.spaceBits() + this.capacity * this.entryBits;
  }

  /** The list, heaviest first. */
  get candidates(): readonly Candidate[] {
    return [...this.entries].sort((a, b) => b.high + b.low - (a.high + a.low));
  }

  private find(value: number): Candidate | undefined {
    return this.entries.find((entry) => entry.value === value);
  }

  ingest(event: StreamEvent): void {
    this.grid.ingest(event);
    const entry = this.find(event.value);
    if (event.op === "delete") {
      if (!entry) return;
      entry.low = Math.max(0, entry.low - 1);
      entry.high = Math.max(0, entry.high - 1);
      if (entry.high === 0) this.entries = this.entries.filter((candidate) => candidate !== entry); // nothing of it is left: free the place
      return;
    }
    if (entry) {
      entry.low += 1;
      entry.high += 1;
      return;
    }
    const high = this.grid.estimate(event.value);
    const low = Math.min(high, Math.max(1, Math.floor(high - this.grid.errorBand))); // it was just inserted, so at least one is live; rounded down, so still a bound and a whole number
    if (this.entries.length < this.capacity) {
      this.entries.push({ value: event.value, low, high });
      return;
    }
    let weakest = this.entries[0] as Candidate;
    for (const candidate of this.entries) if (candidate.high < weakest.high) weakest = candidate;
    if (high > weakest.high) this.entries[this.entries.indexOf(weakest)] = { value: event.value, low, high };
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "frequency") return null;
    const entry = this.find(challenge.value);
    if (!entry) return this.grid.query(challenge);
    return { estimate: (entry.low + entry.high) / 2, low: entry.low, high: entry.high, confidence: this.grid.bandConfidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: {
        grid: this.grid.snapshot() as unknown as Json,
        values: this.entries.map((e) => e.value),
        lows: this.entries.map((e) => e.low),
        highs: this.entries.map((e) => e.high),
      },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): TopKTracker {
    expectKind(snapshot, "topKTracker");
    const tracker = new TopKTracker(optionsFromSnapshot(snapshot), constants);
    const grid = snapshot.state.grid;
    if (typeof grid !== "object" || grid === null || Array.isArray(grid)) throw new RangeError('Bad snapshot: "grid" must be an object');
    tracker.grid = CountMinSketch.fromSnapshot(grid as unknown as StructureSnapshot, constants);
    const values = readCounts(snapshot.state, "values");
    const lows = readCounts(snapshot.state, "lows", values.length);
    const highs = readCounts(snapshot.state, "highs", values.length);
    if (values.length > tracker.capacity) throw new RangeError('Bad snapshot: "values" exceeds the candidate list');
    tracker.entries = values.map((value, i) => ({ value, low: lows[i] as number, high: highs[i] as number }));
    return tracker;
  }

  clone(): TopKTracker {
    const copy = new TopKTracker(this.options, this.constants);
    copy.grid = this.grid.clone();
    copy.entries = this.entries.map((entry) => ({ ...entry }));
    return copy;
  }
}
