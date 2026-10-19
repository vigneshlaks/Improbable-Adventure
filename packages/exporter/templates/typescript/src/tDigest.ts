interface Centroid {
  mean: number;
  weight: number;
}

/** The fewest centroids worth having. */
const MIN_COMPRESSION = 8;

/**
 * t-digest (Dunning): estimates quantiles of a stream of numbers, most accurately at the extremes (the 1st and 99th percentiles, the tail latencies
 * people care about), in a few kilobytes. It keeps weighted centroids, each the mean of the values it stands for. A scale function
 * k(q) = compression / (2 pi) x asin(2q - 1) limits how many values one centroid may stand for: a centroid covers at most one unit of k, which is wide in
 * the middle of the distribution and narrow at both ends. So the rank error at quantile q is about 4 sqrt(q (1 - q)) / compression of the values:
 * small in the tails, larger in the middle (the opposite of a KLL Sketch, which is the same everywhere). New values wait in a buffer and are merged
 * into the centroids when the centroids and the buffer together reach `compression`. The smallest and largest value are kept exactly. Values cannot be
 * removed. Two digests of the same compression merge. Size it with `sizeTDigest` in sizing.ts.
 */
export class TDigest {
  readonly compression: number;
  private centroids: Centroid[] = [];
  private buffer: number[] = [];
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = Number.NEGATIVE_INFINITY;
  private added = 0;

  constructor(compression: number) {
    if (!(compression >= MIN_COMPRESSION)) throw new RangeError(`A t-digest needs a compression of at least ${MIN_COMPRESSION}`);
    this.compression = Math.floor(compression);
  }

  /** Values added. */
  get count(): number {
    return this.added;
  }

  /** The centroids as they would be after merging everything held. */
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

  add(value: number): void {
    if (!Number.isFinite(value)) throw new RangeError("A t-digest takes finite numbers");
    this.added++;
    this.minValue = Math.min(this.minValue, value);
    this.maxValue = Math.max(this.maxValue, value);
    this.buffer.push(value);
    if (this.centroids.length + this.buffer.length >= this.compression) {
      this.centroids = this.merged();
      this.buffer = [];
    }
  }

  /** The value at a quantile between 0 and 1 (0.99 is the 99th percentile), interpolated between centroids, or null when nothing was added. */
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
        return span <= 0 ? c.mean : previous.mean + ((c.mean - previous.mean) * (target - previous.center)) / span;
      }
      previous = { center, mean: c.mean };
      before += c.weight;
    }
    const span = total - previous.center;
    return span <= 0 ? this.maxValue : previous.mean + ((this.maxValue - previous.mean) * (target - previous.center)) / span;
  }

  /** The rank error to expect at a quantile, as a share of the values: 4 sqrt(q (1 - q)) / compression. */
  rankError(quantile: number): number {
    return (4 * Math.sqrt(quantile * (1 - quantile))) / this.compression;
  }

  /** The digest of both streams: the centroids and unmerged values of both, merged by the scale function. Needs the same compression. */
  merge(other: TDigest): TDigest {
    if (other.compression !== this.compression) throw new Error("t-digests merge only with the same compression");
    const merged = new TDigest(this.compression);
    merged.centroids = [...this.centroids.map((c) => ({ ...c })), ...other.centroids.map((c) => ({ ...c }))];
    merged.buffer = [...this.buffer, ...other.buffer];
    merged.minValue = Math.min(this.minValue, other.minValue);
    merged.maxValue = Math.max(this.maxValue, other.maxValue);
    merged.added = this.added + other.added;
    merged.centroids = merged.merged();
    merged.buffer = [];
    return merged;
  }
}
