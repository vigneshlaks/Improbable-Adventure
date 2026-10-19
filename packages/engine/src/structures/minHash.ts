import { murmur3U32 } from "../hash/murmur3";
import { binomialUpper, zForConfidence } from "../stats/stats";
import { deletedShare } from "./ghosts";
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

/** The slots a MinHash needs to say anything: with fewer the similarity is too coarse to use. */
const MIN_SLOTS = 8;
/** A slot that has seen no value. It is above every hash, which are below 2^32. */
const EMPTY = 2 ** 32;
/** Spaces out the seeds of the slots' hash functions. */
const SLOT_SALT = 0x9e3779b1;

/**
 * MinHash (Broder): k hash functions, and for each the smallest hash of any value seen. For two sets the chance that their minima for
 * a function agree is exactly their Jaccard similarity, so the share of agreeing slots estimates it, with a standard error of at most
 * 1 / (2 sqrt(k)). A copy's own minima are worked out on the spot from its values, so the structure holds only the k minima: 32 bits per slot.
 *
 * It ignores deletes, as LogLog does: a deleted value stays in the minima. The set it describes is then every value ever inserted, which
 * holds the live set and the ghosts. Its range allows for the ghosts (see `query`). The minima also say how many distinct values were
 * inserted (the number of values n gives each minimum an exponential law with rate n), which the ghost allowance needs.
 */
export class MinHash implements Structure {
  readonly kind = "minHash" as const;
  readonly params: Readonly<Record<string, number>>;

  private minima: number[];
  private insertCount = 0;
  private deleteCount = 0;
  private readonly k: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("minHash", options.spaceBits, MIN_SLOTS * constants.valueBits);
    this.k = Math.floor(options.spaceBits / constants.valueBits);
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.minima = new Array<number>(this.k).fill(EMPTY);
    this.params = { k: this.k };
  }

  spaceBits(): number {
    return this.k * this.constants.valueBits;
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The smallest hash seen by each slot (2^32 for a slot that has seen nothing). */
  get signature(): readonly number[] {
    return this.minima;
  }

  /** The seed of the hash function of slot i. */
  private slotSeed(i: number): number {
    return (this.seed + Math.imul(i + 1, SLOT_SALT)) >>> 0;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // it cannot take a value back out, but it can count the departure
      return;
    }
    this.insertCount++;
    for (let i = 0; i < this.k; i++) {
      const hash = murmur3U32(event.value, this.slotSeed(i));
      if (hash < (this.minima[i] as number)) this.minima[i] = hash;
    }
  }

  /** The signature of a set of values, made with this structure's hash functions. */
  signatureOf(values: readonly number[]): number[] {
    const minima = new Array<number>(this.k).fill(EMPTY);
    for (const value of new Set(values)) {
      for (let i = 0; i < this.k; i++) {
        const hash = murmur3U32(value, this.slotSeed(i));
        if (hash < (minima[i] as number)) minima[i] = hash;
      }
    }
    return minima;
  }

  /** The estimated Jaccard similarity of a set of values to the set of values ever inserted: the share of slots whose minima agree. */
  similarity(values: readonly number[]): number {
    const signature = this.signatureOf(values);
    let agree = 0;
    for (let i = 0; i < this.k; i++) if (signature[i] === this.minima[i] && this.minima[i] !== EMPTY) agree++;
    return agree / this.k;
  }

  /**
   * The estimated number of distinct values ever inserted, and a lower bound for it at a one-sided confidence. If n distinct values were
   * seen, -ln(1 - m / 2^32) for each slot's minimum m is exponential with rate n, so the sum of k of them is Gamma(k, n) and (k - 1) over
   * the sum is an unbiased estimate with relative standard error 1 / sqrt(k - 2). The lower bound is lognormal, as K-Minimum Values' is.
   */
  distinctEver(confidence: number): { estimate: number; low: number } {
    if (this.insertCount === 0) return { estimate: 0, low: 0 };
    let sum = 0;
    for (const m of this.minima) sum += -Math.log1p(-m / 2 ** 32);
    const estimate = (this.k - 1) / sum;
    const sigma = Math.sqrt(Math.log(1 + 1 / (this.k - 2)));
    return { estimate, low: estimate * Math.exp(sigma ** 2 / 2 - zForConfidence(1 - 2 * (1 - confidence)) * sigma) };
  }

  /**
   * Flags the copies whose estimated similarity reaches the threshold (to every value ever inserted: ghosts pull it
   * the other way for a copy that holds them and so lower it for one that does not, and a correction for the ghosts to expect was tried and
   * made the flags no better). A flag is a bet, so the range says how many of the flagged copies
   * are surely real: those whose similarity cannot be below the threshold. The miss chance is shared: half to the copies' estimates (a
   * Hoeffding bound for each of the K, with the half split between them), a quarter to the number of distinct values, a quarter to the ghosts.
   * With r the most that ghosts can be of the values ever inserted, the live similarity is between J - e - r and (J + e) / (1 - r) for the
   * estimate J and the estimate's error e: removing g values from a union of size U moves the shares by at most g / U.
   */
  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "likeness") return null;
    const confidence = this.constants.confidence;
    const miss = 1 - confidence;
    const copies = challenge.copies.length;
    const halfWidth = Math.sqrt(Math.log((2 * copies) / (miss / 2)) / (2 * this.k));

    let ghostShare = 0;
    if (this.deleteCount > 0) {
      const distinct = this.distinctEver(1 - miss / 4);
      const n = Math.max(1, Math.floor(distinct.low));
      const ghosts = Math.min(this.deleteCount, binomialUpper(n, deletedShare(this.insertCount, this.deleteCount), 1 - miss / 4));
      ghostShare = Math.min(1, ghosts / n);
    }

    const flagged: number[] = [];
    let surelyReal = 0;
    challenge.copies.forEach((copy, index) => {
      const similarity = this.similarity(copy);
      if (similarity < challenge.threshold) return;
      flagged.push(challenge.targets[index] as number);
      if (similarity - halfWidth - ghostShare >= challenge.threshold) surelyReal++;
    });
    return { estimate: flagged, low: surelyReal, high: flagged.length, confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: { minima: [...this.minima], inserts: this.insertCount, deletes: this.deleteCount },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): MinHash {
    expectKind(snapshot, "minHash");
    const sketch = new MinHash(optionsFromSnapshot(snapshot), constants);
    const minima = readCounts(snapshot.state, "minima");
    if (minima.length !== sketch.k) throw new RangeError('Bad snapshot: "minima" must have one entry per slot');
    for (const m of minima) if (m > EMPTY) throw new RangeError('Bad snapshot: "minima" must be at most 2^32');
    sketch.minima = [...minima];
    sketch.insertCount = readNumber(snapshot.state, "inserts");
    sketch.deleteCount = readNumber(snapshot.state, "deletes");
    return sketch;
  }

  clone(): MinHash {
    const copy = new MinHash(this.options, this.constants);
    copy.minima = [...this.minima];
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}
