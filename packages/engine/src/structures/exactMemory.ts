import { expectKind, optionsFromSnapshot, readCounts, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  COUNTER_BITS,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/**
 * Exact baseline: a value-to-count table. Exact until it fills, then it refuses new values.
 * Costs (VALUE_BITS + 32) per distinct value.
 */
export class ExactMemory implements Structure {
  readonly kind = "exactMemory" as const;
  readonly params: Readonly<Record<string, number>>;

  private counts = new Map<number, number>();
  private refusedInserts = 0;
  private readonly capacity: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    const entryBits = constants.valueBits + COUNTER_BITS;
    assertSpace("exactMemory", options.spaceBits, entryBits);
    this.capacity = Math.floor(options.spaceBits / entryBits);
    this.params = { capacity: this.capacity };
  }

  spaceBits(): number {
    return this.capacity * (this.constants.valueBits + COUNTER_BITS);
  }

  /** Insert events dropped because the table was full. */
  get refused(): number {
    return this.refusedInserts;
  }

  get size(): number {
    return this.counts.size;
  }

  ingest(event: StreamEvent): void {
    const current = this.counts.get(event.value);
    if (event.op === "insert") {
      if (current !== undefined) this.counts.set(event.value, current + 1);
      else if (this.counts.size < this.capacity) this.counts.set(event.value, 1);
      else this.refusedInserts++;
      return;
    }
    if (current === undefined) return;
    if (current <= 1) this.counts.delete(event.value);
    else this.counts.set(event.value, current - 1);
  }

  query(challenge: Challenge): Answer | null {
    const confidence = this.constants.confidence;
    const missed = this.refusedInserts;
    switch (challenge.kind) {
      case "presence": {
        const flagged = challenge.targets.filter((t) => this.counts.has(t));
        const unflagged = challenge.targets.length - flagged.length;
        return {
          estimate: flagged,
          low: flagged.length,
          high: flagged.length + Math.min(missed, unflagged),
          confidence,
        };
      }
      case "frequency": {
        const count = this.counts.get(challenge.value) ?? 0;
        return { estimate: count, low: count, high: count + missed, confidence };
      }
      case "count":
        return { estimate: this.counts.size, low: this.counts.size, high: this.counts.size + missed, confidence };
    }
  }

  snapshot(): StructureSnapshot {
    // Stored as a flat list [value, count, value, count, ...] in insertion order.
    const entries: number[] = [];
    for (const [value, count] of this.counts) entries.push(value, count);
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { entries, refused: this.refusedInserts },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): ExactMemory {
    expectKind(snapshot, "exactMemory");
    const memory = new ExactMemory(optionsFromSnapshot(snapshot), constants);
    const entries = readCounts(snapshot.state, "entries");
    if (entries.length % 2 !== 0) throw new RangeError('Bad snapshot: "entries" must hold value/count pairs');
    if (entries.length / 2 > memory.capacity) throw new RangeError('Bad snapshot: "entries" exceeds capacity');
    for (let i = 0; i < entries.length; i += 2) memory.counts.set(entries[i] as number, entries[i + 1] as number);
    memory.refusedInserts = readNumber(snapshot.state, "refused");
    return memory;
  }

  clone(): ExactMemory {
    const copy = new ExactMemory(this.options, this.constants);
    copy.counts = new Map(this.counts);
    copy.refusedInserts = this.refusedInserts;
    return copy;
  }
}
