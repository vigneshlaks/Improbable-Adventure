import { KMinimumValues } from "./kMinimumValues";
import { expectKind, optionsFromSnapshot, snapshotHeader } from "./snapshot";
import {
  type Answer,
  type Challenge,
  type Json,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/**
 * Theta Sketch (Dasgupta and others; Apache DataSketches): K-Minimum Values built for set arithmetic. The k smallest hashes of the distinct
 * values are kept, and the largest of them, taken as a share of the hash range, is theta: every value whose hash is below theta is in the
 * sketch, so a sketch is a sample of the values at rate theta. Two sketches of two streams merge into the sketch of the union by taking the
 * k smallest of both, and the same sample gives the count of the union (and, from the hashes both hold, of an intersection).
 *
 * In the game it is the K-Minimum Values structure that **merges by itself**: when two of them watch the two enemies of a fight, their
 * answers are always the union's, with no Merge enchantment needed. Alone it counts as K-Minimum Values does (same Space, same error,
 * same ghost handling), and it answers Count only.
 */
export class ThetaSketch implements Structure {
  readonly kind = "thetaSketch" as const;
  readonly params: Readonly<Record<string, number>>;

  private inner: KMinimumValues;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.inner = new KMinimumValues({ spaceBits: options.spaceBits, ...(options.hashSeed !== undefined ? { hashSeed: options.hashSeed } : {}) }, constants);
    this.params = { ...this.inner.params };
  }

  spaceBits(): number {
    return this.inner.spaceBits();
  }

  /** Theta: the share of the hash range below which every value is in the sketch (1 while it holds every distinct value it has seen). */
  get theta(): number {
    const hashes = this.inner.hashes;
    return hashes.length < (this.params.k as number) ? 1 : (hashes[hashes.length - 1] as number) / 2 ** 32;
  }

  get hashes(): readonly number[] {
    return this.inner.hashes;
  }

  get inserts(): number {
    return this.inner.inserts;
  }

  get deletes(): number {
    return this.inner.deletes;
  }

  ingest(event: StreamEvent): void {
    this.inner.ingest(event);
  }

  query(challenge: Challenge): Answer | null {
    return this.inner.query(challenge);
  }

  /** The sketch of both streams. Needs the same size and seed. */
  merge(other: Structure): ThetaSketch {
    if (!(other instanceof ThetaSketch)) throw new Error("Theta sketches merge only with Theta sketches");
    const merged = this.clone();
    merged.inner = this.inner.merge(other.inner);
    return merged;
  }

  snapshot(): StructureSnapshot {
    return { ...snapshotHeader(this.kind, this.options), state: { kmv: this.inner.snapshot() as unknown as Json } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): ThetaSketch {
    expectKind(snapshot, "thetaSketch");
    const sketch = new ThetaSketch(optionsFromSnapshot(snapshot), constants);
    const inner = snapshot.state.kmv;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new RangeError('Bad snapshot: "kmv" must be a K-Minimum Values snapshot');
    sketch.inner = KMinimumValues.fromSnapshot(inner as unknown as StructureSnapshot, constants);
    return sketch;
  }

  clone(): ThetaSketch {
    const copy = new ThetaSketch(this.options, this.constants);
    copy.inner = this.inner.clone();
    return copy;
  }
}
