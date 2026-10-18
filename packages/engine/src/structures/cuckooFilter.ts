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

/** Mixed into the seed to get the hash that makes a value's fingerprint, and the hash that decides where a pushed fingerprint goes. */
const FINGERPRINT_SALT = 0x85ebca6b;
const ALTERNATE_SALT = 0xc2b2ae35;
const KICK_SALT = 0x27d4eb2f;

/**
 * Cuckoo Filter (Fan, Andersen, Kaminsky and Mitzenmacher): a table of buckets, each holding four short fingerprints of the
 * values inserted. A value's fingerprint (f bits, never zero) can sit in one of two buckets: the one its hash picks, or the one
 * `alternate` gives from that bucket and the fingerprint alone, so a fingerprint can be moved without knowing its value.
 * An insert takes a free place in either bucket; if both are full it pushes a fingerprint out of one to its other bucket, and so on,
 * up to a limit of pushes, after which the fingerprint it is holding is dropped.
 *
 * A query flags a value when its fingerprint is in either of its buckets. A value that was never inserted is flagged by chance, at
 * about 8 / 2^f at full load. Unlike a Bloom Filter it can delete (it removes one matching fingerprint), at the price that a table
 * pushed past about 95 percent full starts dropping fingerprints, which hides real values: false negatives.
 * Which bucket to push from is chosen by a hash of a counter, not a random generator, so the same inserts always make the same table.
 *
 * The bucket count is whatever fits, not a power of two: the alternate bucket is `(H(fingerprint) - bucket) mod buckets`, which
 * maps each of a pair to the other.
 */
export class CuckooFilter implements Structure {
  readonly kind = "cuckooFilter" as const;
  readonly params: Readonly<Record<string, number>>;

  private table: Uint16Array;
  private entries = 0;
  private lostCount = 0;
  private deleteCount = 0;
  private kicks = 0;
  private readonly buckets: number;
  private readonly bucketSize: number;
  private readonly fingerprintBits: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    this.fingerprintBits = options.knob ?? constants.cuckooFingerprintBits;
    if (!Number.isInteger(this.fingerprintBits) || this.fingerprintBits < 1 || this.fingerprintBits > 16) {
      throw new RangeError(`A fingerprint takes a whole number of bits from 1 to 16, got ${this.fingerprintBits}`);
    }
    this.bucketSize = constants.cuckooBucketSize;
    assertSpace("cuckooFilter", options.spaceBits, 2 * this.bucketSize * this.fingerprintBits);
    this.buckets = Math.floor(options.spaceBits / (this.bucketSize * this.fingerprintBits));
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.table = new Uint16Array(this.buckets * this.bucketSize);
    this.params = { buckets: this.buckets, bucketSize: this.bucketSize, fingerprintBits: this.fingerprintBits, capacity: this.buckets * this.bucketSize };
  }

  spaceBits(): number {
    return this.buckets * this.bucketSize * this.fingerprintBits;
  }

  /** Fingerprints stored. */
  get size(): number {
    return this.entries;
  }

  /** Fingerprints dropped because an insert could not place them. Each can hide one real value. */
  get lost(): number {
    return this.lostCount;
  }

  /** The share of places taken. */
  get load(): number {
    return this.entries / this.table.length;
  }

  private fingerprint(value: number): number {
    const range = 2 ** this.fingerprintBits - 1;
    return (murmur3U32(value, (this.seed ^ FINGERPRINT_SALT) >>> 0) % range) + 1;
  }

  private bucketOf(value: number): number {
    return murmur3U32(value, this.seed) % this.buckets;
  }

  /** The other bucket a fingerprint may sit in; applying it twice gives the bucket back. */
  private alternate(bucket: number, fingerprint: number): number {
    const h = murmur3U32(fingerprint, (this.seed ^ ALTERNATE_SALT) >>> 0) % this.buckets;
    return (((h - bucket) % this.buckets) + this.buckets) % this.buckets;
  }

  private slotOf(bucket: number, fingerprint: number): number {
    for (let i = 0; i < this.bucketSize; i++) if (this.table[bucket * this.bucketSize + i] === fingerprint) return bucket * this.bucketSize + i;
    return -1;
  }

  private place(bucket: number, fingerprint: number): boolean {
    const slot = this.slotOf(bucket, 0);
    if (slot < 0) return false;
    this.table[slot] = fingerprint;
    return true;
  }

  private contains(value: number): boolean {
    const fp = this.fingerprint(value);
    const first = this.bucketOf(value);
    return this.slotOf(first, fp) >= 0 || this.slotOf(this.alternate(first, fp), fp) >= 0;
  }


  ingest(event: StreamEvent): void {
    const fp = this.fingerprint(event.value);
    const first = this.bucketOf(event.value);
    const second = this.alternate(first, fp);
    if (event.op === "delete") {
      this.deleteCount++;
      const slot = this.slotOf(first, fp) >= 0 ? this.slotOf(first, fp) : this.slotOf(second, fp);
      if (slot >= 0) {
        this.table[slot] = 0;
        this.entries--;
      }
      return;
    }
    this.entries++;
    if (this.place(first, fp) || this.place(second, fp)) return;
    // Both buckets are full: push fingerprints along, each to its other bucket.
    let held = fp;
    let bucket = murmur3U32(this.kicks, (this.seed ^ KICK_SALT) >>> 0) % 2 === 0 ? first : second;
    for (let kick = 0; kick < this.constants.cuckooMaxKicks; kick++) {
      const choice = murmur3U32(this.kicks++, (this.seed ^ KICK_SALT) >>> 0) % this.bucketSize;
      const slot = bucket * this.bucketSize + choice;
      const pushed = this.table[slot] as number;
      this.table[slot] = held;
      held = pushed;
      bucket = this.alternate(bucket, held);
      if (this.place(bucket, held)) return;
    }
    this.entries--; // the fingerprint it still holds has nowhere to go, and is dropped
    this.lostCount++;
  }

  /**
   * The chance that a value that was never inserted is flagged, at the load now: it needs one of the (up to) eight fingerprints in
   * its two buckets to equal its own, and a fingerprint takes one of 2^f - 1 values.
   */
  falsePositiveRate(): number {
    return 1 - Math.pow(1 - 1 / (2 ** this.fingerprintBits - 1), 2 * this.bucketSize * this.load);
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "presence") return null;
    const confidence = this.constants.confidence;
    const hits = challenge.targets.filter((t) => this.contains(t));
    const unflagged = challenge.targets.length - hits.length;
    // Extra flags are collisions: at most `maxFalse` are plausible at this confidence. Hidden real values come from fingerprints that
    // were dropped (each hides at most one value), and from deletes that took a look-alike's fingerprint instead of the value's own,
    // which happens with at most the false-positive chance for each delete.
    const maxFalse = binomialUpper(challenge.targets.length, this.falsePositiveRate(), confidence);
    const hidden = Math.min(unflagged, this.lostCount + binomialUpper(this.deleteCount, this.falsePositiveRate(), confidence));
    return { estimate: hits, low: Math.max(0, hits.length - maxFalse), high: Math.min(challenge.targets.length, hits.length + hidden), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { table: Array.from(this.table), entries: this.entries, lost: this.lostCount, deletes: this.deleteCount, kicks: this.kicks },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): CuckooFilter {
    expectKind(snapshot, "cuckooFilter");
    const filter = new CuckooFilter(optionsFromSnapshot(snapshot), constants);
    filter.table = Uint16Array.from(readCounts(snapshot.state, "table", filter.table.length));
    filter.entries = readNumber(snapshot.state, "entries");
    filter.lostCount = readNumber(snapshot.state, "lost");
    filter.deleteCount = readNumber(snapshot.state, "deletes");
    filter.kicks = readNumber(snapshot.state, "kicks");
    return filter;
  }

  clone(): CuckooFilter {
    const copy = new CuckooFilter(this.options, this.constants);
    copy.table = new Uint16Array(this.table);
    copy.entries = this.entries;
    copy.lostCount = this.lostCount;
    copy.deleteCount = this.deleteCount;
    copy.kicks = this.kicks;
    return copy;
  }
}
