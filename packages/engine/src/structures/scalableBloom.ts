import { binomialUpper } from "../stats/stats";
import { BloomFilter } from "./bloomFilter";
import { expectKind, optionsFromSnapshot, readNumber, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  DEFAULT_HASH_SEED,
  type Answer,
  type Challenge,
  type Json,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/** The least Space that holds a first layer worth the name. */
const MIN_SPACE = 256;
/** Each new layer is this many times the size of the one before it, until the reserve runs out. */
const GROWTH = 2;
/** The ln 2 that turns a false-positive target into bits per item: an optimal filter needs log2(1 / p) / ln 2 bits for each. */
const LN2 = Math.LN2;

/** The false-positive target of layer `index`: the first layer's, tightened by the factor for each layer after it. */
export function layerTarget(constants: StructureConstants, index: number): number {
  return constants.scalableBloomTarget * constants.scalableBloomTightening ** index;
}

/**
 * Scalable Bloom Filter (Almeida and others): a stack of Bloom filters. It starts with one layer and, when that layer holds as many
 * items as it was sized for, adds a larger one with a tighter false-positive target, so a stream that grows past what was planned does
 * not saturate it. A value is present if any layer reports it, so the false-positive rates of the layers add up: with targets
 * p, p r, p r^2, ... they sum to p / (1 - r), a bound that stays put however long the stream.
 *
 * The Space is the budget for all layers. The first layer takes `scalableBloomFirstShare` of it and the rest is a reserve that later
 * layers draw from, each twice the last (or what is left); a layer is sized by its false-positive target, so it holds as many items as
 * `bits / (log2(1 / p) / ln 2)`. Once the reserve is spent the last layer keeps taking items and its false-positive rate climbs like an
 * ordinary Bloom filter's. It cannot delete: it counts the deletes it sees, as a Bloom filter does.
 */
export class ScalableBloom implements Structure {
  readonly kind = "scalableBloom" as const;
  readonly params: Readonly<Record<string, number>>;

  private layers: BloomFilter[] = [];
  private capacities: number[] = [];
  private inLayer: number[] = [];
  private reserve: number;
  private insertCount = 0;
  private deleteCount = 0;
  private readonly seed: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("scalableBloom", options.spaceBits, MIN_SPACE);
    this.seed = options.hashSeed ?? DEFAULT_HASH_SEED;
    this.reserve = options.spaceBits;
    this.addLayer(Math.max(64, Math.floor(options.spaceBits * constants.scalableBloomFirstShare)));
    this.params = { firstLayerBits: (this.layers[0] as BloomFilter).spaceBits(), firstLayerItems: this.capacities[0] as number };
  }

  /** Adds a layer of `bits`, sized for its target. */
  private addLayer(bits: number): void {
    const index = this.layers.length;
    const p = layerTarget(this.constants, index);
    const bitsPerItem = Math.log2(1 / p) / LN2;
    const capacity = Math.max(1, Math.floor(bits / bitsPerItem));
    this.layers.push(new BloomFilter({ spaceBits: bits, knob: capacity, hashSeed: (this.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0 }, this.constants));
    this.capacities.push(capacity);
    this.inLayer.push(0);
    this.reserve -= bits;
  }

  spaceBits(): number {
    return this.options.spaceBits;
  }

  get layerCount(): number {
    return this.layers.length;
  }

  get inserts(): number {
    return this.insertCount;
  }

  get deletes(): number {
    return this.deleteCount;
  }

  /** How full each layer is, as a share of its bits set. */
  get layerFills(): number[] {
    return this.layers.map((layer) => layer.fill);
  }

  /** The Space still unspent in the reserve. */
  get reserveBits(): number {
    return this.reserve;
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++;
      return;
    }
    this.insertCount++;
    const last = this.layers.length - 1;
    if (this.inLayer[last] === undefined) return;
    if ((this.inLayer[last] as number) >= (this.capacities[last] as number) && this.reserve >= 64) {
      const previous = (this.layers[last] as BloomFilter).spaceBits();
      this.addLayer(Math.min(this.reserve, previous * GROWTH));
    }
    const top = this.layers.length - 1;
    const layer = this.layers[top] as BloomFilter;
    if (!this.layers.slice(0, top + 1).some((l) => l.has(event.value))) {
      layer.ingest(event);
      this.inLayer[top] = (this.inLayer[top] as number) + 1;
    }
  }

  /** The chance a value that was never inserted is reported: one minus the chance that no layer reports it. */
  falsePositiveRate(): number {
    let clear = 1;
    for (const layer of this.layers) clear *= 1 - layer.currentFalsePositiveRate();
    return 1 - clear;
  }

  query(challenge: Challenge): Answer | null {
    if (challenge.kind !== "presence") return null;
    const flagged = challenge.targets.filter((t) => this.layers.some((layer) => layer.has(t)));
    const maxFalse = binomialUpper(challenge.targets.length, this.falsePositiveRate(), this.constants.confidence);
    const ghosts = Math.min(this.deleteCount, flagged.length);
    return { estimate: flagged, low: Math.max(0, flagged.length - maxFalse - ghosts), high: flagged.length, confidence: this.constants.confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      state: {
        layers: this.layers.map((layer) => layer.snapshot() as unknown as Json),
        inLayer: [...this.inLayer],
        reserve: this.reserve,
        inserts: this.insertCount,
        deletes: this.deleteCount,
      },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): ScalableBloom {
    expectKind(snapshot, "scalableBloom");
    const filter = new ScalableBloom(optionsFromSnapshot(snapshot), constants);
    const layers = snapshot.state.layers;
    const inLayer = snapshot.state.inLayer;
    if (!Array.isArray(layers) || layers.length === 0 || !Array.isArray(inLayer) || inLayer.length !== layers.length) throw new RangeError('Bad snapshot: "layers" must be a list with a count for each');
    filter.layers = layers.map((layer) => BloomFilter.fromSnapshot(layer as unknown as StructureSnapshot, constants));
    filter.capacities = filter.layers.map((layer, i) => {
      const bitsPerItem = Math.log2(1 / layerTarget(constants, i)) / LN2;
      return Math.max(1, Math.floor(layer.spaceBits() / bitsPerItem));
    });
    filter.inLayer = inLayer.map((n) => {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new RangeError('Bad snapshot: "inLayer" must hold counts');
      return n;
    });
    filter.reserve = readNumber(snapshot.state, "reserve");
    filter.insertCount = readNumber(snapshot.state, "inserts");
    filter.deleteCount = readNumber(snapshot.state, "deletes");
    return filter;
  }

  clone(): ScalableBloom {
    const copy = new ScalableBloom(this.options, this.constants);
    copy.layers = this.layers.map((layer) => layer.clone());
    copy.capacities = [...this.capacities];
    copy.inLayer = [...this.inLayer];
    copy.reserve = this.reserve;
    copy.insertCount = this.insertCount;
    copy.deleteCount = this.deleteCount;
    return copy;
  }
}

