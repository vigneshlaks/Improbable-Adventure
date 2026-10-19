import { murmur3U32 } from "../hash/murmur3";
import { binomialUpper } from "../stats/stats";
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

/** The metadata bits each slot of a quotient filter carries beside its remainder: occupied, continuation and shifted. */
const METADATA_BITS = 3;
/** The fewest quotient bits worth having (four slots). */
const MIN_QUOTIENT_BITS = 2;

/**
 * Quotient Filter (Bender and others): a hash table that keeps only a fingerprint of each value, in a compact table of 2^q slots. A
 * value's hash is cut into a q-bit quotient, which says which slot is its home, and an r-bit remainder, which is what the slot stores;
 * together they are a fingerprint of q + r bits. Values with the same quotient form a sorted run, and the three metadata bits of a slot
 * (occupied, continuation, shifted) let runs push each other along the table and still be found. So a slot costs r + 3 bits and the table
 * 2^q (r + 3), with q as large as fits the Space.
 *
 * What the game needs of it is its behaviour, which this keeps without simulating the shifting: it holds a multiset of fingerprints, one
 * for each insert, up to 2^q of them; a query flags a value whose fingerprint it holds, so a value never inserted is flagged by chance,
 * about n / 2^(q + r) for n stored (the load times 2^-r); a delete removes one copy of the fingerprint, exactly, which can be a look-alike's
 * (at that same chance); and a full table cannot take another fingerprint, so the insert is dropped and the value is hidden (a false negative).
 * Two filters of the same shape and seed merge into the filter of both.
 */
export class QuotientFilter implements Structure {
  readonly kind = "quotientFilter" as const;
  readonly params: Readonly<Record<string, number>>;

  private fingerprints = new Map<number, number>();
  private entries = 0;
  private lostCount = 0;
  private deleteCount = 0;
  private readonly q: number;
  private readonly r: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.r = options.knob ?? constants.quotientRemainderBits;
    if (!Number.isInteger(this.r) || this.r < 1 || this.r > 16) throw new RangeError(`A remainder takes a whole number of bits from 1 to 16, got ${this.r}`);
    assertSpace("quotientFilter", options.spaceBits, 2 ** MIN_QUOTIENT_BITS * (this.r + METADATA_BITS));
    let q = MIN_QUOTIENT_BITS;
    while (q < 16 && 2 ** (q + 1) * (this.r + METADATA_BITS) <= options.spaceBits) q++;
    this.q = q;
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.params = { quotientBits: this.q, remainderBits: this.r, slots: 2 ** this.q };
  }

  spaceBits(): number {
    return 2 ** this.q * (this.r + METADATA_BITS);
  }

  /** Fingerprints held, counting repeats. */
  get size(): number {
    return this.entries;
  }

  /** The share of the slots in use. */
  get load(): number {
    return this.entries / 2 ** this.q;
  }

  /** Inserts dropped because the table was full: each hides a value. */
  get lost(): number {
    return this.lostCount;
  }

  /** The chance a value that was never inserted has the fingerprint of one that was: the stored fingerprints over all that exist. */
  falsePositiveRate(): number {
    return Math.min(1, this.fingerprints.size / 2 ** (this.q + this.r));
  }

  private fingerprint(value: number): number {
    return murmur3U32(value, this.seed) >>> (32 - this.q - this.r);
  }

  ingest(event: StreamEvent): void {
    const fp = this.fingerprint(event.value);
    const held = this.fingerprints.get(fp) ?? 0;
    if (event.op === "delete") {
      this.deleteCount++;
      if (held > 0) {
        if (held === 1) this.fingerprints.delete(fp);
        else this.fingerprints.set(fp, held - 1);
        this.entries--;
      }
      return;
    }
    if (this.entries >= 2 ** this.q) {
      this.lostCount++;
      return;
    }
    this.fingerprints.set(fp, held + 1);
    this.entries++;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "presence") return null;
    const confidence = this.constants.confidence;
    const hits = challenge.targets.filter((t) => this.fingerprints.has(this.fingerprint(t)));
    const unflagged = challenge.targets.length - hits.length;
    // Extra flags are look-alike fingerprints: at most `maxFalse` are plausible at this confidence. Hidden real values come from inserts the
    // full table dropped, and from deletes that removed a look-alike's fingerprint instead of the value's own.
    const maxFalse = binomialUpper(challenge.targets.length, this.falsePositiveRate(), confidence);
    const hidden = Math.min(unflagged, this.lostCount + binomialUpper(this.deleteCount, this.falsePositiveRate(), confidence));
    return { estimate: hits, low: Math.max(0, hits.length - maxFalse), high: Math.min(challenge.targets.length, hits.length + hidden), confidence };
  }

  snapshot(): StructureSnapshot {
    const flat: number[] = [];
    for (const fp of [...this.fingerprints.keys()].sort((a, b) => a - b)) flat.push(fp, this.fingerprints.get(fp) as number);
    return { ...snapshotHeader(this.kind, this.options), state: { fingerprints: flat, lost: this.lostCount, deletes: this.deleteCount } };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): QuotientFilter {
    expectKind(snapshot, "quotientFilter");
    const filter = new QuotientFilter(optionsFromSnapshot(snapshot), constants);
    const flat = readCounts(snapshot.state, "fingerprints");
    if (flat.length % 2 !== 0) throw new RangeError('Bad snapshot: "fingerprints" must hold fingerprint/count pairs');
    for (let i = 0; i < flat.length; i += 2) {
      const fp = flat[i] as number;
      const count = flat[i + 1] as number;
      if (fp >= 2 ** (filter.q + filter.r) || count < 1) throw new RangeError('Bad snapshot: "fingerprints" holds an impossible pair');
      filter.fingerprints.set(fp, count);
      filter.entries += count;
    }
    if (filter.entries > 2 ** filter.q) throw new RangeError('Bad snapshot: "fingerprints" exceeds the slots');
    filter.lostCount = readNumber(snapshot.state, "lost");
    filter.deleteCount = readNumber(snapshot.state, "deletes");
    return filter;
  }

  clone(): QuotientFilter {
    const copy = new QuotientFilter(this.options, this.constants);
    copy.fingerprints = new Map(this.fingerprints);
    copy.entries = this.entries;
    copy.lostCount = this.lostCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }

  /** The filter of both streams: every fingerprint of each, as far as the slots go (what does not fit is dropped and counted as lost). */
  merge(other: Structure): QuotientFilter {
    if (!(other instanceof QuotientFilter) || other.q !== this.q || other.r !== this.r || other.seed !== this.seed) {
      throw new Error("Quotient filters merge only with same-shaped, same-seeded Quotient filters");
    }
    const merged = this.clone();
    for (const fp of [...other.fingerprints.keys()].sort((a, b) => a - b)) {
      for (let i = 0; i < (other.fingerprints.get(fp) as number); i++) {
        if (merged.entries >= 2 ** merged.q) merged.lostCount++;
        else {
          merged.fingerprints.set(fp, (merged.fingerprints.get(fp) ?? 0) + 1);
          merged.entries++;
        }
      }
    }
    merged.lostCount += other.lostCount;
    merged.deleteCount += other.deleteCount;
    return merged;
  }
}
