import { doubleHashIndices } from "../hash/doubleHash";
import { binomialUpper } from "../stats/stats";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
} from "./types";

/** Bits per item assumed when the player gives no expected item count (about 1% false positives). */
export const DEFAULT_BITS_PER_ITEM = 10;

/** Expected false-positive rate for m bits, n items and k hashes. */
export function bloomFalsePositiveRate(m: number, n: number, k: number): number {
  return Math.pow(1 - Math.exp((-k * n) / m), k);
}

/** The hash count that minimizes false positives for m bits and n items. */
export function bloomOptimalK(m: number, n: number): number {
  return Math.max(1, Math.round((m / n) * Math.LN2));
}

/**
 * Bloom filter: a bit array of m = Space bits. Knob: expected item count n, from which the hash count k is derived.
 * It never misses a real value but can flag a decoy. It cannot delete, so deleted values stay flagged.
 */
export class BloomFilter implements Structure {
  readonly kind = "bloomFilter" as const;
  readonly params: Readonly<Record<string, number>>;

  private bits: Uint32Array;
  private setBits = 0;
  private insertCount = 0;
  private readonly m: number;
  private readonly k: number;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("bloomFilter", options.spaceBits, 1);
    this.m = options.spaceBits;
    const n = Math.max(1, Math.floor(options.knob ?? this.m / DEFAULT_BITS_PER_ITEM));
    this.k = bloomOptimalK(this.m, n);
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.bits = new Uint32Array(Math.ceil(this.m / 32));
    this.params = { m: this.m, k: this.k, expectedItems: n };
  }

  spaceBits(): number {
    return this.m;
  }

  /** Fraction of bits currently set. */
  get fill(): number {
    return this.setBits / this.m;
  }

  /** Insert events processed (duplicates included). */
  get inserted(): number {
    return this.insertCount;
  }

  private test(value: number): boolean {
    for (const idx of doubleHashIndices(value, this.k, this.m, this.seed)) {
      if (((this.bits[idx >>> 5] ?? 0) & (1 << (idx & 31))) === 0) return false;
    }
    return true;
  }

  ingest(event: StreamEvent): void {
    if (event.op !== "insert") return; // Bloom filters cannot delete
    this.insertCount++;
    for (const idx of doubleHashIndices(event.value, this.k, this.m, this.seed)) {
      const word = idx >>> 5;
      const mask = 1 << (idx & 31);
      const current = this.bits[word] ?? 0;
      if ((current & mask) === 0) {
        this.bits[word] = current | mask;
        this.setBits++;
      }
    }
  }

  /** False-positive rate right now, estimated from how full the bit array is. */
  currentFalsePositiveRate(): number {
    return Math.pow(this.fill, this.k);
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "presence") return null;
    const flagged = challenge.targets.filter((t) => this.test(t));
    // Every real target is flagged, so extra flags are false alarms. Subtracting the most false alarms
    // plausible at this confidence gives the low bound.
    const maxFalse = binomialUpper(challenge.targets.length, this.currentFalsePositiveRate(), this.constants.confidence);
    return {
      estimate: flagged,
      low: Math.max(0, flagged.length - maxFalse),
      high: flagged.length,
      confidence: this.constants.confidence,
    };
  }

  clone(): BloomFilter {
    const copy = new BloomFilter(this.options, this.constants);
    copy.bits = new Uint32Array(this.bits);
    copy.setBits = this.setBits;
    copy.insertCount = this.insertCount;
    return copy;
  }

  merge(other: Structure): BloomFilter {
    if (!(other instanceof BloomFilter) || other.m !== this.m || other.k !== this.k || other.seed !== this.seed) {
      throw new Error("Bloom filters merge only with same-shaped, same-seeded Bloom filters");
    }
    const merged = this.clone();
    let count = 0;
    for (let i = 0; i < merged.bits.length; i++) {
      const word = (merged.bits[i] ?? 0) | (other.bits[i] ?? 0);
      merged.bits[i] = word;
      count += popcount32(word);
    }
    merged.setBits = count;
    merged.insertCount = this.insertCount + other.insertCount;
    return merged;
  }
}

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}
