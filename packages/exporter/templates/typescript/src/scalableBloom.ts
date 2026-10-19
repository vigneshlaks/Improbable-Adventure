import { DEFAULT_SEED, type Item } from "./hash.ts";
import { BloomFilter } from "./bloomFilter.ts";

/** Each new layer holds this many times as many items as the one before, and is this many times less likely to flag a stranger. */
const GROWTH = 2;
const TIGHTENING = 0.5;
/** The layers' targets add up to this share of the rate asked for (0.45 / (1 - 0.5) = 0.9), leaving a tenth for rounding in the layers' sizes. */
const FIRST_LAYER_SHARE = 0.45;
const SEED_SALT = 0x9e3779b1;

/**
 * Scalable Bloom Filter: a stack of Bloom Filters that grows with the set, so you need not know how many items there will be. It starts with one
 * layer for `initialCapacity` items; when a layer holds as many items as it was sized for, a layer twice as big is added whose false-positive
 * target is half as large. An item is present if any layer says so, so the layers' rates add up; with targets p, p / 2, p / 4, ... they sum to
 * less than 2p, and the filter is sized with p = 0.45 x rate, so the rate stays under the one asked for however long the stream. It cannot remove
 * items. A plain Bloom Filter sized right for the set needs less memory: this is for a set of unknown size. Size it with `sizeScalable` in sizing.ts.
 */
export class ScalableBloomFilter {
  readonly initialCapacity: number;
  readonly falsePositiveTarget: number;
  readonly seed: number;
  private readonly layers: BloomFilter[] = [];
  private readonly capacities: number[] = [];
  private readonly counts: number[] = [];

  constructor(initialCapacity: number, falsePositiveRate: number, seed = DEFAULT_SEED) {
    if (!(initialCapacity >= 1)) throw new RangeError("A Scalable Bloom Filter needs room for at least one item");
    if (!(falsePositiveRate > 0 && falsePositiveRate < 1)) throw new RangeError("The false-positive rate must be between 0 and 1");
    this.initialCapacity = Math.floor(initialCapacity);
    this.falsePositiveTarget = falsePositiveRate;
    this.seed = seed;
    this.addLayer();
  }

  private addLayer(): void {
    const index = this.layers.length;
    const capacity = this.initialCapacity * GROWTH ** index;
    const p = this.falsePositiveTarget * FIRST_LAYER_SHARE * TIGHTENING ** index; // the layers' targets add up to 0.9 of the target asked for
    const bits = Math.ceil((-capacity * Math.log(p)) / Math.LN2 ** 2);
    const hashes = Math.max(1, Math.round((bits / capacity) * Math.LN2));
    this.layers.push(new BloomFilter(bits, hashes, (this.seed + Math.imul(index + 1, SEED_SALT)) >>> 0));
    this.capacities.push(capacity);
    this.counts.push(0);
  }

  /** The number of layers so far. */
  get layerCount(): number {
    return this.layers.length;
  }

  /** The memory it takes now, in bits. */
  get memoryBits(): number {
    return this.layers.reduce((sum, layer) => sum + layer.bits, 0);
  }

  /** Adds an item. An item some layer already reports takes no room. */
  add(item: Item): void {
    if (this.mightContain(item)) return;
    const last = this.layers.length - 1;
    if ((this.counts[last] as number) >= (this.capacities[last] as number)) this.addLayer();
    const top = this.layers.length - 1;
    (this.layers[top] as BloomFilter).add(item);
    this.counts[top] = (this.counts[top] as number) + 1;
  }

  /** False means certainly never added. True means probably added. */
  mightContain(item: Item): boolean {
    return this.layers.some((layer) => layer.mightContain(item));
  }

  /** The chance that an item never added is reported: one minus the chance that no layer reports it. */
  get falsePositiveRate(): number {
    return 1 - this.layers.reduce((clear, layer) => clear * (1 - layer.falsePositiveRate()), 1);
  }
}
