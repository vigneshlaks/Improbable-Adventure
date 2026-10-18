import { thinningShift } from "./quantiles";
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

/** The most centroids a digest can be asked to hold must be at least this, or it has nothing to summarize with. */
const MIN_SLOTS = 8;

interface Centroid {
  mean: number;
  weight: number;
}

/**
 * t-digest (Dunning): an approximate quantile summary made of weighted centroids, each the mean of the values it stands for.
 * A scale function k(q) = compression / (2 pi) x asin(2q - 1) limits how many units one centroid may stand for: a centroid
 * covers at most one unit of k, which is wide in the middle of the distribution and narrow at both ends, so a t-digest
 * is sharpest at extreme quantiles (the 1st and 99th percentiles) and coarser in the middle: the opposite of KLL's uniform error.
 *
 * It costs 64 bits per slot (a 32-bit mean and a 32-bit weight), and holds at most that many centroids and unmerged values together.
 * When they would exceed that they are merged with the scale function's limit; the compression is the slot count, which leaves about
 * half the slots free as a buffer for the next values. A query merges a copy first, so asking never changes the digest.
 * Between centroids the quantile is interpolated; the smallest and largest value seen are kept exactly.
 *
 * It cannot delete: it counts the deletes it sees. Deletes remove units at random, so they leave the quantile in place and add
 * noise, which the range allows for as Reservoir Sampling's and KLL's do.
 */
export class TDigest implements Structure {
  readonly kind = "tDigest" as const;
  readonly params: Readonly<Record<string, number>>;

  private centroids: Centroid[] = [];
  private buffer: number[] = [];
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = Number.NEGATIVE_INFINITY;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly slots: number;
  private readonly compression: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("tDigest", options.spaceBits, MIN_SLOTS * 2 * COUNTER_BITS);
    this.slots = Math.floor(options.spaceBits / (2 * COUNTER_BITS));
    this.compression = this.slots;
    this.params = { slots: this.slots, compression: this.compression };
  }

  spaceBits(): number {
    return this.slots * 2 * COUNTER_BITS;
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** The centroids as they would be after merging everything held (without changing the digest). */
  get summary(): readonly Centroid[] {
    return this.merged();
  }

  private scale(q: number): number {
    return (this.compression / (2 * Math.PI)) * Math.asin(2 * Math.min(1, Math.max(0, q)) - 1);
  }

  private inverseScale(k: number): number {
    return k >= this.compression / 4 ? 1 : (Math.sin((k * 2 * Math.PI) / this.compression) + 1) / 2;
  }

  /** Merges the centroids and the buffered values into centroids that respect the scale function's limit. */
  private merged(): Centroid[] {
    const items: Centroid[] = [...this.centroids, ...this.buffer.map((mean) => ({ mean, weight: 1 }))].sort((a, b) => a.mean - b.mean);
    if (items.length === 0) return [];
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    const out: Centroid[] = [];
    let current: Centroid = { ...(items[0] as Centroid) };
    let before = 0;
    let limit = this.inverseScale(this.scale(0) + 1) * total;
    for (let i = 1; i < items.length; i++) {
      const next = items[i] as Centroid;
      if (before + current.weight + next.weight <= limit) {
        const weight = current.weight + next.weight;
        current = { mean: (current.mean * current.weight + next.mean * next.weight) / weight, weight };
      } else {
        before += current.weight;
        out.push(current);
        limit = this.inverseScale(this.scale(before / total) + 1) * total;
        current = { ...next };
      }
    }
    out.push(current);
    return out;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++;
      return;
    }
    this.insertCount++;
    this.minValue = Math.min(this.minValue, event.value);
    this.maxValue = Math.max(this.maxValue, event.value);
    this.buffer.push(event.value);
    if (this.centroids.length + this.buffer.length >= this.slots) {
      this.centroids = this.merged();
      this.buffer = [];
    }
  }

  /** The value at a quantile of the units inserted (interpolated between centroids), or null when nothing was inserted. */
  quantile(quantile: number): number | null {
    const centroids = this.merged();
    if (centroids.length === 0) return null;
    const total = centroids.reduce((sum, c) => sum + c.weight, 0);
    const target = quantile * total;
    let before = 0;
    let previous: { center: number; mean: number } = { center: 0, mean: this.minValue };
    for (const c of centroids) {
      const center = before + c.weight / 2;
      if (target <= center) {
        const span = center - previous.center;
        const value = span <= 0 ? c.mean : previous.mean + ((c.mean - previous.mean) * (target - previous.center)) / span;
        return Math.round(value);
      }
      previous = { center, mean: c.mean };
      before += c.weight;
    }
    const last = previous;
    const span = total - last.center;
    return Math.round(span <= 0 ? this.maxValue : last.mean + ((this.maxValue - last.mean) * (target - last.center)) / span);
  }

  /** The rank error to expect at a quantile, as a share of the units: the coefficient times sqrt(q (1 - q)) over the compression. */
  rankError(quantile: number): number {
    return (this.constants.tdigestRankError * Math.sqrt(quantile * (1 - quantile))) / this.compression;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "rank") return null;
    const confidence = this.constants.confidence;
    const estimate = this.quantile(challenge.quantile);
    if (estimate === null) return { estimate: 0, low: 0, high: Number.POSITIVE_INFINITY, confidence };
    const live = Math.max(1, this.insertCount - this.deleteCount);
    const shift = this.rankError(challenge.quantile) + (this.deleteCount === 0 ? 0 : thinningShift(live, challenge.quantile, confidence));
    const low = this.quantile(Math.max(0, challenge.quantile - shift)) as number;
    const high = this.quantile(Math.min(1, challenge.quantile + shift)) as number;
    return { estimate, low: Math.min(low, estimate), high: Math.max(high, estimate), confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: {
        means: this.centroids.map((c) => c.mean),
        weights: this.centroids.map((c) => c.weight),
        buffer: [...this.buffer],
        min: this.insertCount === 0 ? 0 : this.minValue,
        max: this.insertCount === 0 ? 0 : this.maxValue,
        inserts: this.insertCount,
        deletes: this.deleteCount,
      },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): TDigest {
    expectKind(snapshot, "tDigest");
    const digest = new TDigest(optionsFromSnapshot(snapshot), constants);
    const weights = readCounts(snapshot.state, "weights");
    const means = (snapshot.state.means as number[] | undefined) ?? [];
    if (!Array.isArray(means) || means.length !== weights.length || means.some((m) => typeof m !== "number" || !Number.isFinite(m))) {
      throw new RangeError('Bad snapshot: "means" must match "weights"');
    }
    const buffer = readCounts(snapshot.state, "buffer");
    if (weights.length + buffer.length > digest.slots) throw new RangeError("Bad snapshot: more centroids and values than slots");
    digest.centroids = means.map((mean, i) => ({ mean, weight: weights[i] as number }));
    digest.buffer = [...buffer];
    digest.insertCount = readNumber(snapshot.state, "inserts");
    digest.deleteCount = readNumber(snapshot.state, "deletes");
    if (digest.insertCount > 0) {
      digest.minValue = readNumber(snapshot.state, "min");
      digest.maxValue = readNumber(snapshot.state, "max");
    }
    return digest;
  }

  clone(): TDigest {
    const copy = new TDigest(this.options, this.constants);
    copy.centroids = this.centroids.map((c) => ({ ...c }));
    copy.buffer = [...this.buffer];
    copy.minValue = this.minValue;
    copy.maxValue = this.maxValue;
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}
