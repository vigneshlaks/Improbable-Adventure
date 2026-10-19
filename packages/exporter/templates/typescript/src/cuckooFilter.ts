import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

const BUCKET_SIZE = 4;
const MAX_KICKS = 500;
/** Mixed into the seed to get the hashes that make an item's fingerprint, the other bucket of a fingerprint, and the choice of what to push. */
const FINGERPRINT_SALT = 0x85ebca6b;
const ALTERNATE_SALT = 0xc2b2ae35;
const KICK_SALT = 0x27d4eb2f;

/**
 * Cuckoo Filter: answers "have I seen this?" like a Bloom Filter, and can also forget. It keeps a short fingerprint of every item in a table of
 * buckets of four. An item's fingerprint can sit in one of two buckets (the one its hash picks, and a second that follows from the first and
 * the fingerprint alone), so a fingerprint can be moved without knowing its item. A full pair of buckets pushes a fingerprint to its other
 * bucket, and so on up to a limit, after which `add` gives up and returns false: the table is too full (above about 95 percent) and an item
 * you believed was added is lost. A query says yes for an item whose fingerprint is in either bucket, so a never-added item is a false yes
 * with chance about 8 / 2^fingerprintBits at full load. Size it with `sizeCuckoo` in sizing.ts.
 */
export class CuckooFilter {
  readonly buckets: number;
  readonly fingerprintBits: number;
  readonly seed: number;
  private readonly table: Uint16Array;
  private entries = 0;
  private kicks = 0;

  constructor(buckets: number, fingerprintBits: number, seed = DEFAULT_SEED) {
    if (!(buckets >= 1) || !Number.isInteger(fingerprintBits) || fingerprintBits < 1 || fingerprintBits > 16) {
      throw new RangeError("A Cuckoo Filter needs at least one bucket and a fingerprint of 1 to 16 bits");
    }
    this.buckets = Math.floor(buckets);
    this.fingerprintBits = fingerprintBits;
    this.seed = seed;
    this.table = new Uint16Array(this.buckets * BUCKET_SIZE);
  }

  /** The places in the table, and the share of them taken. */
  get capacity(): number {
    return this.buckets * BUCKET_SIZE;
  }
  get size(): number {
    return this.entries;
  }
  get load(): number {
    return this.entries / this.capacity;
  }

  private fingerprint(item: Item): number {
    return (hash32(item, (this.seed ^ FINGERPRINT_SALT) >>> 0) % (2 ** this.fingerprintBits - 1)) + 1; // never zero: zero marks an empty place
  }

  private bucketOf(item: Item): number {
    return hash32(item, this.seed) % this.buckets;
  }

  /** The other bucket a fingerprint may sit in; applying it twice gives the bucket back. */
  private alternate(bucket: number, fingerprint: number): number {
    const h = hash32(fingerprint, (this.seed ^ ALTERNATE_SALT) >>> 0) % this.buckets;
    return (((h - bucket) % this.buckets) + this.buckets) % this.buckets;
  }

  private slotOf(bucket: number, fingerprint: number): number {
    for (let i = 0; i < BUCKET_SIZE; i++) if (this.table[bucket * BUCKET_SIZE + i] === fingerprint) return bucket * BUCKET_SIZE + i;
    return -1;
  }

  private place(bucket: number, fingerprint: number): boolean {
    const slot = this.slotOf(bucket, 0);
    if (slot < 0) return false;
    this.table[slot] = fingerprint;
    return true;
  }

  /** Adds an item. Returns false if the table was too full to take it (the item is then not in the filter). */
  add(item: Item): boolean {
    const fp = this.fingerprint(item);
    const first = this.bucketOf(item);
    const second = this.alternate(first, fp);
    if (this.place(first, fp) || this.place(second, fp)) {
      this.entries++;
      return true;
    }
    let held = fp;
    let bucket = hash32(this.kicks, (this.seed ^ KICK_SALT) >>> 0) % 2 === 0 ? first : second;
    for (let kick = 0; kick < MAX_KICKS; kick++) {
      const choice = hash32(this.kicks++, (this.seed ^ KICK_SALT) >>> 0) % BUCKET_SIZE;
      const slot = bucket * BUCKET_SIZE + choice;
      const pushed = this.table[slot] as number;
      this.table[slot] = held;
      held = pushed;
      bucket = this.alternate(bucket, held);
      if (this.place(bucket, held)) {
        this.entries++;
        return true;
      }
    }
    return false; // the fingerprint it still holds has nowhere to go: one earlier item is now forgotten
  }

  /** Removes one copy of an item's fingerprint. Only remove items that were added: removing a stranger can remove a look-alike. */
  remove(item: Item): boolean {
    const fp = this.fingerprint(item);
    const first = this.bucketOf(item);
    const slot = this.slotOf(first, fp) >= 0 ? this.slotOf(first, fp) : this.slotOf(this.alternate(first, fp), fp);
    if (slot < 0) return false;
    this.table[slot] = 0;
    this.entries--;
    return true;
  }

  /** True if the item may have been added; false means it certainly was not (unless a fingerprint was lost when the table was too full). */
  has(item: Item): boolean {
    const fp = this.fingerprint(item);
    const first = this.bucketOf(item);
    return this.slotOf(first, fp) >= 0 || this.slotOf(this.alternate(first, fp), fp) >= 0;
  }

  /** The chance that an item never added is reported: it needs one of the eight fingerprints in its two buckets to equal its own. */
  get falsePositiveRate(): number {
    return 1 - (1 - 1 / (2 ** this.fingerprintBits - 1)) ** (2 * BUCKET_SIZE * this.load);
  }
}
