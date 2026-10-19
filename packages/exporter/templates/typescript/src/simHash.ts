import { DEFAULT_SEED, hash32, type Item } from "./hash.ts";

/** Spaces out the seeds of the hash functions that give the planes' signs. */
const GROUP_SALT = 0x9e3779b1;

/** A key that is the same for equal items, so a set can count each once. */
const keyOf = (item: Item): string => (typeof item === "object" ? `b${Array.from(item).join(",")}` : `${typeof item}${item}`);

/**
 * SimHash: how alike two sets are, from the angle between them, read off a fingerprint of signs. Each of `planes` random planes gives every item a
 * sign (a bit of its hash), and keeps a counter of the signs of the items added. The fingerprint is the sign of each counter. A set of items
 * gets its own signs the same way, and the share of planes where the two disagree estimates the angle between them divided by pi, with the
 * spread of a binomial over the planes. The cosine of that angle is shared / sqrt(size of one x size of the other) for sets, so with the two
 * sizes the Jaccard similarity follows.
 *
 * It is rough, and weak on duplicates: it cannot count different items, so it takes the stream's size as its effective number of values,
 * n^2 over the mean squared counter (exact when every item is added equally often, too small when a few are added a lot, which then
 * look less like their copies than they are). It cannot remove items. `planes` is a multiple of 32. Size it with `sizeSimHash` in sizing.ts.
 */
export class SimHash {
  readonly planes: number;
  readonly seed: number;
  private readonly counters: Int32Array;
  private readonly cap: number;
  private added = 0;

  constructor(planes: number, seed = DEFAULT_SEED, counterBits = 16) {
    if (!Number.isInteger(planes) || planes < 32 || planes % 32 !== 0) throw new RangeError("SimHash needs a multiple of 32 planes, at least 32");
    if (!Number.isInteger(counterBits) || counterBits < 4 || counterBits > 31) throw new RangeError("A counter takes 4 to 31 bits");
    this.planes = planes;
    this.seed = seed;
    this.cap = 2 ** (counterBits - 1) - 1;
    this.counters = new Int32Array(planes);
  }

  /** The signs an item gives the planes: +1 or -1 for each. */
  private signs(item: Item): Int8Array {
    const out = new Int8Array(this.planes);
    for (let group = 0; group < this.planes / 32; group++) {
      const hash = hash32(item, (this.seed + Math.imul(group + 1, GROUP_SALT)) >>> 0);
      for (let bit = 0; bit < 32; bit++) out[group * 32 + bit] = (hash >>> bit) & 1 ? 1 : -1;
    }
    return out;
  }

  add(item: Item): void {
    this.added++;
    const signs = this.signs(item);
    for (let i = 0; i < this.planes; i++) this.counters[i] = Math.max(-this.cap, Math.min(this.cap, (this.counters[i] as number) + (signs[i] as number)));
  }

  /** The effective number of values added: n^2 over the mean squared counter. */
  effectiveSize(): number {
    if (this.added === 0) return 0;
    let squares = 0;
    for (const c of this.counters) squares += c * c;
    const meanSquare = squares / this.planes;
    return meanSquare <= 0 ? this.added : Math.max(1, Math.min(this.added, this.added ** 2 / meanSquare));
  }

  /** The share of planes whose sign differs between the stream and a set of items: the estimate of their angle divided by pi. */
  differing(items: readonly Item[]): number {
    const sums = new Int32Array(this.planes);
    const seen = new Set<string>();
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) continue; // a set counts each item once
      seen.add(key);
      const signs = this.signs(item);
      for (let i = 0; i < this.planes; i++) sums[i] = (sums[i] as number) + (signs[i] as number);
    }
    let differ = 0;
    for (let i = 0; i < this.planes; i++) if (((this.counters[i] as number) >= 0) !== ((sums[i] as number) >= 0)) differ++;
    return differ / this.planes;
  }

  /** The estimated Jaccard similarity of a set of items to the stream, from the angle and the two sizes. */
  similarity(items: readonly Item[]): number {
    const copySize = new Set(items.map(keyOf)).size;
    return SimHash.similarityAt(this.differing(items), this.effectiveSize(), copySize);
  }

  /** The Jaccard similarity that goes with an angle (as a share of pi), for a stream of `streamSize` values and a copy of `copySize`. */
  static similarityAt(share: number, streamSize: number, copySize: number): number {
    const shared = Math.max(0, Math.min(streamSize, copySize, Math.cos(Math.PI * share) * Math.sqrt(streamSize * copySize)));
    const union = streamSize + copySize - shared;
    return union <= 0 ? 1 : shared / union;
  }

  /** The most the angle's share is likely to be off, at one standard error: sqrt(p (1 - p) / planes), at most 1 / (2 sqrt(planes)). */
  get standardError(): number {
    return 1 / (2 * Math.sqrt(this.planes));
  }
}
