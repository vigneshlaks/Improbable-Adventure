import { CountMinSketch } from "./countMinSketch.ts";
import { DEFAULT_SEED } from "./hash.ts";

const SEED_SALT = 0x9e3779b1;

/**
 * Dyadic Count-Min (Cormode and Muthukrishnan): quantiles and ranks from Count-Min Sketches. A value is cut to its top `bits` bits, giving 2^bits
 * ordered buckets (the value range split into equal parts, each 2^(32 - bits) values wide). Level j counts every aligned run of 2^j buckets (the
 * dyadic intervals: the whole range, its halves, quarters, ...), so the number of items at or below any value is a sum of at most `bits + 1` of
 * those counts, and a quantile is found by walking down from the whole range, going left when the target falls in the left half. A level with few
 * intervals (at most `exactMax`) is kept in exact counters; the others are Count-Min Sketches of `width` columns and `depth` rows, which only
 * overcount, so the rank of a value is never too low and is too high by at most the sum of the sketches' bands, `rankOvershoot`. Values are whole numbers
 * from 0 to 2^32 - 1. Items can be removed. Size it with `sizeDyadic` in sizing.ts.
 */
export class DyadicCountMin {
  readonly bits: number;
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  readonly exactMax: number;
  private readonly exact: Array<Uint32Array | null> = [];
  private readonly sketches: Array<CountMinSketch | null> = [];
  private total = 0;

  constructor(bits: number, width: number, depth: number, seed = DEFAULT_SEED, exactMax = 64) {
    if (!Number.isInteger(bits) || bits < 2 || bits > 32) throw new RangeError("A Dyadic Count-Min takes 2 to 32 bits of the value");
    this.bits = bits;
    this.width = Math.floor(width);
    this.depth = Math.floor(depth);
    this.seed = seed;
    this.exactMax = exactMax;
    for (let j = 0; j < bits; j++) {
      if (2 ** (bits - j) <= exactMax) {
        this.exact.push(new Uint32Array(2 ** (bits - j)));
        this.sketches.push(null);
      } else {
        this.exact.push(null);
        this.sketches.push(new CountMinSketch(width, depth, (seed + Math.imul(j + 1, SEED_SALT)) >>> 0));
      }
    }
  }

  /** Items added minus items removed. */
  get liveTotal(): number {
    return this.total;
  }

  /** The width of one bucket, in values. */
  get bucketWidth(): number {
    return 2 ** (32 - this.bits);
  }

  private bucket(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError("A value is a whole number from 0 to 2^32 - 1");
    return value >>> (32 - this.bits);
  }

  add(value: number): void {
    const bucket = this.bucket(value);
    for (let j = 0; j < this.bits; j++) {
      const level = this.exact[j];
      if (level) level[bucket >>> j] = (level[bucket >>> j] as number) + 1;
      else (this.sketches[j] as CountMinSketch).add(bucket >>> j);
    }
    this.total++;
  }

  /** Takes back an earlier addition. Only remove values that were added. */
  remove(value: number): void {
    if (this.total === 0) return;
    const bucket = this.bucket(value);
    for (let j = 0; j < this.bits; j++) {
      const level = this.exact[j];
      if (level) level[bucket >>> j] = Math.max(0, (level[bucket >>> j] as number) - 1);
      else (this.sketches[j] as CountMinSketch).remove(bucket >>> j);
    }
    this.total--;
  }

  /** The count of the aligned run of 2^level buckets with this key: exact above, an overestimate in a sketch. */
  private count(level: number, key: number): number {
    if (level === this.bits) return this.total;
    const exact = this.exact[level];
    return exact ? (exact[key] as number) : (this.sketches[level] as CountMinSketch).estimate(key);
  }

  /** The sum of what the sketches may overshoot by, expected: the band `e N / width` of each. */
  get rankOvershoot(): number {
    let band = 0;
    for (const sketch of this.sketches) if (sketch) band += sketch.overshoot;
    return band;
  }

  /** The number of items at or below the bucket of a value (the whole bucket counts), never too low and too high by at most `rankOvershoot`. */
  rank(value: number): number {
    let remaining = this.bucket(value) + 1; // the buckets 0 .. bucket, as the largest runs of 2^j buckets that fit, one after another
    let position = 0;
    let sum = 0;
    for (let j = this.bits; j >= 0; j--) {
      const run = 2 ** j;
      if (remaining >= run) {
        sum += this.count(j, position / run);
        position += run;
        remaining -= run;
      }
    }
    return Math.min(this.total, sum);
  }

  /** The bucket that holds the unit at `target` (counting from 1) when the units are in order, as far as the counts say. */
  private bucketAt(target: number): number {
    let key = 0;
    let remaining = Math.max(1, Math.ceil(target));
    for (let level = this.bits; level > 0; level--) {
      const left = Math.min(this.count(level - 1, key * 2), this.count(level, key));
      if (remaining <= left) key = key * 2;
      else {
        remaining -= left;
        key = key * 2 + 1;
      }
    }
    return key;
  }

  /**
   * The value at a quantile between 0 and 1: the upper edge of the bucket found, with its lower edge, and an upper end for where the quantile can be
   * (the upper edge of the bucket found for the target plus the overshoot), which is Infinity when that reaches past the total. Null when nothing is held.
   */
  quantile(quantile: number): { estimate: number; low: number; high: number } | null {
    if (this.total <= 0) return null;
    const target = quantile * this.total;
    const found = this.bucketAt(target);
    const bound = target + this.rankOvershoot;
    const above = bound <= this.total ? this.bucketAt(bound) : null;
    return {
      estimate: (found + 1) * this.bucketWidth - 1,
      low: found * this.bucketWidth,
      high: above === null ? Number.POSITIVE_INFINITY : (above + 1) * this.bucketWidth - 1,
    };
  }
}
