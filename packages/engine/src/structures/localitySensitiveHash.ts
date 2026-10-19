import { MinHash } from "./minHash";
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

/** The chance that some band of r rows agrees for a copy of similarity s, with b bands: 1 - (1 - s^r)^b. */
export function candidateChance(similarity: number, rows: number, bands: number): number {
  return 1 - (1 - similarity ** rows) ** bands;
}

/**
 * The most rows a band can have while a copy exactly at the threshold is still flagged with chance `recall`, for k minima cut into bands of that many
 * (k / rows of them): more rows make a band pickier, so the flags are fewer, but a real copy near the threshold must not be missed.
 */
export function bandRowsFor(k: number, threshold: number, recall: number): number {
  let best = 1;
  for (let rows = 1; rows <= k; rows++) {
    if (candidateChance(threshold, rows, Math.floor(k / rows)) >= recall) best = rows;
    else break;
  }
  return best;
}

/**
 * Locality-Sensitive Hashing (Indyk and Motwani; the banding of Leskovec and others): MinHash with its minima cut into bands of r rows.
 * A copy is a candidate if, in some band, all the rows agree with the stream's: a copy of similarity s does that with chance
 * 1 - (1 - s^r)^b for b = k / r bands, which is high for the copies that matter and low for the far ones. Candidates are what it flags. The
 * rows are the most that still flag a copy exactly at the threshold with chance `lshRecall` (0.9), so it **misses almost no real copy**
 * (the real ones are above the threshold), at the price of flagging look-alikes that are close to it too: a decoy at 0.5 is flagged more
 * often than not. From MinHash's estimate it says how many of the flagged are surely real.
 *
 * It is a MinHash inside, with the same Space, the same ghost handling and the same bound for "surely real".
 */
export class LocalitySensitiveHash implements Structure {
  readonly kind = "lsh" as const;
  readonly params: Readonly<Record<string, number>>;

  private inner: MinHash;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    // The inner sketch is built with the plain options: its snapshot carries the kind "minHash".
    this.inner = new MinHash({ spaceBits: options.spaceBits, ...(options.hashSeed !== undefined ? { hashSeed: options.hashSeed } : {}) }, constants);
    const k = this.inner.params.k as number;
    this.params = { slots: k };
  }

  spaceBits(): number {
    return this.inner.spaceBits();
  }

  get inserts(): number {
    return this.inner.inserts;
  }

  get deletes(): number {
    return this.inner.deletes;
  }

  /** The minima, as the inner MinHash holds them. */
  get signature(): readonly number[] {
    return this.inner.signature;
  }

  ingest(event: StreamEvent): void {
    this.inner.ingest(event);
  }

  /** The rows of a band for this threshold. */
  rowsFor(threshold: number): number {
    return bandRowsFor(this.params.slots as number, threshold, this.constants.lshRecall);
  }

  /** Whether some band of the copy's signature agrees with the stream's in every row. */
  isCandidate(values: readonly number[], threshold: number): boolean {
    const copy = this.inner.signatureOf(values);
    const mine = this.inner.signature;
    const rows = this.rowsFor(threshold);
    const bands = Math.floor((this.params.slots as number) / rows);
    for (let band = 0; band < bands; band++) {
      let agree = true;
      for (let row = 0; row < rows; row++) {
        const i = band * rows + row;
        if (copy[i] !== mine[i] || mine[i] === 2 ** 32) {
          agree = false;
          break;
        }
      }
      if (agree) return true;
    }
    return false;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "likeness") return null;
    const assessed = this.inner.assess(challenge);
    const flagged = challenge.copies.flatMap((copy, index) => (this.isCandidate(copy, challenge.threshold) ? [index] : []));
    return {
      estimate: flagged.map((index) => challenge.targets[index] as number),
      low: flagged.filter((index) => assessed[index]?.surelyReal).length,
      high: flagged.length,
      confidence: this.constants.confidence,
    };
  }

  snapshot(): StructureSnapshot {
    return { ...snapshotHeader(this.kind, this.options), state: { minHash: this.inner.snapshot() as unknown as Json } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): LocalitySensitiveHash {
    expectKind(snapshot, "lsh");
    const sketch = new LocalitySensitiveHash(optionsFromSnapshot(snapshot), constants);
    const inner = snapshot.state.minHash;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new RangeError('Bad snapshot: "minHash" must be a MinHash snapshot');
    sketch.inner = MinHash.fromSnapshot(inner as unknown as StructureSnapshot, constants);
    return sketch;
  }

  clone(): LocalitySensitiveHash {
    const copy = new LocalitySensitiveHash(this.options, this.constants);
    copy.inner = this.inner.clone();
    return copy;
  }
}
