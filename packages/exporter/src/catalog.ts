import type { StructureKind } from "@pda/engine";
import { number, pct, size } from "./format";
import {
  sizeBloom,
  sizeCountMin,
  sizeCountSketch,
  sizeCuckoo,
  sizeExact,
  sizeHyperLogLog,
  sizeKmv,
  sizeLinearCounting,
  sizeLogLog,
  sizeMinHash,
  sizeQuotient,
  sizeReservoir,
  sizeScalable,
  sizeSimHash,
  sizeSpectral,
  type SizingConstants,
  type Workload,
} from "./sizing";

/** One structure's sizing, ready to print: the Space it takes, the arguments to construct it with, and two lines saying what that gives. */
export interface Row {
  summary: string[];
  args: Record<string, number>;
  bits: number;
}

/**
 * Everything the exporter knows about one structure that has reference code: where its templates are, how to construct it, when to use it, and how to
 * size it for a real workload. The toolkit, the reports and the tradeoff profile all read this, so a structure is added in one place.
 */
export interface CatalogEntry {
  /** The class name in both languages. */
  cls: string;
  /** The template file of each language, without extension, and the helper files it needs besides (named as in TypeScript; Python's are the snake_case of them). */
  typescript: string;
  python: string;
  needs: string[];
  /** The constructor's arguments, in order, as they are named in `Row.args`. */
  args: string[];
  guide: { use: string; avoid: string };
  /** Sizes the structure for a workload, or says in a sentence what is missing. May throw a RangeError for a target that cannot be met. */
  size(workload: Workload, constants: SizingConstants): Row | string;
  /** The Space production-grade sizing needs for a stream at the default error, or null when there is no rule. */
  production(workload: Pick<Workload, "items" | "distinct">, constants: SizingConstants): number | null;
  /** The formula behind the sizing, in a sentence. */
  formula(constants: SizingConstants): string;
}

const missing = (workload: Workload, field: keyof Workload, label: string): string | null => (workload[field] === undefined ? `Needs ${label}.` : null);

export const CATALOG: Partial<Record<StructureKind, CatalogEntry>> = {
  exactMemory: {
    cls: "ExactMemory",
    typescript: "exactMemory",
    python: "exact_memory",
    needs: [],
    args: [],
    guide: { use: "The set of different items is small enough to store (thousands to a few million), or you need a ground truth to test the others against.", avoid: "Memory must stay fixed while the number of different items grows." },
    size(workload, constants) {
      const lack = missing(workload, "distinct", "the number of different items");
      if (lack) return lack;
      const s = sizeExact(workload, constants);
      return { bits: s.memoryBits, args: {}, summary: [`${number(s.entries)} entries (${size(s.memoryBits)}) at ${constants.valueBits + constants.counterBits} bits each`, "no error at all"] };
    },
    production: (workload, constants) => sizeExact(workload, constants).memoryBits,
    formula: (c) => `bits = distinct x (${c.valueBits} + ${c.counterBits}).`,
  },
  reservoirSampling: {
    cls: "ReservoirSampling",
    typescript: "reservoirSampling",
    python: "reservoir_sampling",
    needs: [],
    args: ["sampleSize"],
    guide: { use: "You need a fair random sample of a stream of unknown length, to estimate shares or to look at real examples.", avoid: "You need exact counts of rare items; a sample misses them." },
    size(workload, constants) {
      const s = sizeReservoir(workload, constants);
      return { bits: s.memoryBits, args: { sampleSize: s.sampleSize }, summary: [`a sample of ${number(s.sampleSize)} items (${size(s.memoryBits)})`, `a share estimated from it is within ${pct(s.error)} of the truth at ${pct(constants.confidence)} confidence`] };
    },
    production: (workload, constants) => sizeReservoir(workload, constants).memoryBits,
    formula: (c) => `sample size = z^2 x 0.25 / error^2, with z = 1.96 at ${pct(c.confidence)} confidence (the worst case, a share of one half).`,
  },
  bloomFilter: {
    cls: "BloomFilter",
    typescript: "bloomFilter",
    python: "bloom_filter",
    needs: [],
    args: ["bits", "hashes"],
    guide: { use: "You ask \"have I seen this?\" and can tolerate occasional false yeses but never false nos (cache and database lookups, deduplication).", avoid: "Items must be removed, or a false yes is costly with no way to check." },
    size(workload, constants) {
      const lack = missing(workload, "items", "the item count");
      if (lack) return lack;
      const s = sizeBloom(workload, constants);
      return { bits: s.memoryBits, args: { bits: s.bits, hashes: s.hashes }, summary: [`${number(s.bits)} bits (${size(s.bits)}) and ${s.hashes} hashes`, `false-positive rate ${pct(s.falsePositiveRate)}`] };
    },
    production: (workload, constants) => sizeBloom(workload, constants).memoryBits,
    formula: () => "bits m = -n ln(p) / (ln 2)^2; hashes k = round(m / n x ln 2); false-positive rate p = (1 - e^(-k n / m))^k. The size is raised until the rate with a whole number of hashes meets the target.",
  },
  countMinSketch: {
    cls: "CountMinSketch",
    typescript: "countMinSketch",
    python: "count_min_sketch",
    needs: [],
    args: ["width", "depth"],
    guide: { use: "You need approximate counts per item (heavy hitters, rate limiting) in fixed memory.", avoid: "You need exact counts, or most items are rare: its overshoot is a fixed share of the total, which swamps small counts." },
    size(workload, constants) {
      const s = sizeCountMin(workload, constants);
      return { bits: s.memoryBits, args: { width: s.width, depth: s.depth }, summary: [`${number(s.width)} columns by ${s.depth} rows (${size(s.memoryBits)})`, `an estimate overshoots by at most ${pct(s.errorShare)} of all items added${workload.items ? ` (about ${number(s.overshoot)} for ${number(workload.items)} items)` : ""}, with probability ${pct(s.confidence)}`] };
    },
    production: (workload, constants) => sizeCountMin(workload, constants).memoryBits,
    formula: (c) => `width w = ceil(e / error); depth d = ceil(ln(1 / (1 - confidence))); bits = ${c.counterBits} x w x d. An estimate never underestimates and overshoots by at most (e / w) x N with probability 1 - e^(-d).`,
  },
  linearCounting: {
    cls: "LinearCounting",
    typescript: "linearCounting",
    python: "linear_counting",
    needs: [],
    args: ["bits"],
    guide: { use: "You count different items and the count is small or roughly known in advance, so a bit array can be sized for it.", avoid: "The count can grow far past the bit array: it saturates and then only gives a lower limit." },
    size(workload, constants) {
      const lack = missing(workload, "distinct", "the number of different items");
      if (lack) return lack;
      const s = sizeLinearCounting(workload, constants);
      return { bits: s.memoryBits, args: { bits: s.bits }, summary: [`${number(s.bits)} bits (${size(s.bits)})`, `standard error ${pct(s.standardError)} at ${number(workload.distinct as number)} different items; it saturates well above that`] };
    },
    production: (workload, constants) => sizeLinearCounting(workload, constants).memoryBits,
    formula: () => "standard error = sqrt(m (e^t - t - 1)) / n with t = n / m; the smallest m that meets the target is found by search.",
  },
  logLog: {
    cls: "LogLog",
    typescript: "logLog",
    python: "log_log",
    needs: ["registers"],
    args: ["indexBits"],
    guide: { use: "You count different items with tiny memory and want the simplest arithmetic.", avoid: "You can use HyperLogLog, which needs fewer registers for the same error." },
    size(workload, constants) {
      const s = sizeLogLog(workload, constants);
      return { bits: s.memoryBits, args: { indexBits: s.indexBits }, summary: [`${number(s.registers)} registers (index bits ${s.indexBits}, ${size(s.memoryBits)})`, `standard error ${pct(s.standardError)}`] };
    },
    production: (workload, constants) => sizeLogLog(workload, constants).memoryBits,
    formula: (c) => `registers m = 2^ceil(log2((${c.logLogErrorCoefficient} / error)^2)); bits = ${c.registerBits} x m; standard error = ${c.logLogErrorCoefficient} / sqrt(m).`,
  },
  hyperLogLog: {
    cls: "HyperLogLog",
    typescript: "hyperLogLog",
    python: "hyper_log_log",
    needs: ["registers"],
    args: ["indexBits"],
    guide: { use: "You count different items, possibly billions, in kilobytes, and can accept an error of a percent or two. Counters can be merged across machines.", avoid: "You need an exact count, or the count is small enough to store exactly." },
    size(workload, constants) {
      const s = sizeHyperLogLog(workload, constants);
      return { bits: s.memoryBits, args: { indexBits: s.indexBits }, summary: [`${number(s.registers)} registers (index bits ${s.indexBits}, ${size(s.memoryBits)})`, `standard error ${pct(s.standardError)}`] };
    },
    production: (workload, constants) => sizeHyperLogLog(workload, constants).memoryBits,
    formula: (c) => `registers m = 2^ceil(log2((${c.hyperLogLogErrorCoefficient} / error)^2)); bits = ${c.registerBits} x m; standard error = ${c.hyperLogLogErrorCoefficient} / sqrt(m).`,
  },
  countSketch: {
    cls: "CountSketch",
    typescript: "countSketch",
    python: "count_sketch",
    needs: [],
    args: ["width", "depth"],
    guide: { use: "You need approximate counts per item, a few items are far heavier than the rest, and you want errors that cancel instead of always overshooting.", avoid: "You need a count that never underestimates (use Count-Min), or most items are light and similar: its error follows the whole stream's L2 norm." },
    size(workload, constants) {
      const s = sizeCountSketch(workload, constants);
      return { bits: s.memoryBits, args: { width: s.width, depth: s.depth }, summary: [`${number(s.width)} columns by ${s.depth} rows (${size(s.memoryBits)})`, `an estimate is within ${pct(s.errorShare)} of the L2 norm of the counts (the square root of the sum of their squares) of the truth, with probability ${pct(s.confidence)}`] };
    },
    production: (workload, constants) => sizeCountSketch(workload, constants).memoryBits,
    formula: (c) => `width w = ceil(4 / error^2); depth d = the smallest odd number with e^(-0.1438 d) <= 1 - confidence (${pct(c.confidence)}); bits = ${c.counterBits} x w x d. A row is wrong by more than error x L2 norm with probability at most 1/4 (Chebyshev), and the median of d rows is wrong only if half of them are.`,
  },
  cuckooFilter: {
    cls: "CuckooFilter",
    typescript: "cuckooFilter",
    python: "cuckoo_filter",
    needs: [],
    args: ["buckets", "fingerprintBits"],
    guide: { use: "You ask \"have I seen this?\" like a Bloom filter, and items must also be removable (sessions, caches that expire, sets that change).", avoid: "The set can grow past what you sized for: above about 95 percent full it refuses adds, and a refused add loses an earlier item." },
    size(workload, constants) {
      const lack = missing(workload, "items", "the item count");
      if (lack) return lack;
      const s = sizeCuckoo(workload, constants);
      return { bits: s.memoryBits, args: { buckets: s.buckets, fingerprintBits: s.fingerprintBits }, summary: [`${number(s.buckets)} buckets of 4, with ${s.fingerprintBits}-bit fingerprints (${size(s.memoryBits)})`, `false-positive rate about ${pct(s.falsePositiveRate)}, at 95 percent full`] };
    },
    production: (workload, constants) => (workload.items === undefined ? null : sizeCuckoo(workload, constants).memoryBits),
    formula: () => "buckets = ceil(items / (4 x 0.95)); fingerprint bits f = ceil(log2(8 / error)); bits = buckets x 4 x f; false-positive rate about 8 / 2^f at full load.",
  },
  kMinimumValues: {
    cls: "KMinimumValues",
    typescript: "kMinimumValues",
    python: "k_minimum_values",
    needs: [],
    args: ["k"],
    guide: { use: "You count different items and need to combine counts from several streams (two sketches merge into the sketch of the union), or want a count that is exact while small.", avoid: "Items are removed: it cannot forget. HyperLogLog needs less memory for the same error." },
    size(workload, constants) {
      const s = sizeKmv(workload, constants);
      return { bits: s.memoryBits, args: { k: s.k }, summary: [`k = ${number(s.k)} hashes (${size(s.memoryBits)})`, `standard error ${pct(s.standardError)}; exact until ${number(s.k)} different items`] };
    },
    production: (workload, constants) => sizeKmv(workload, constants).memoryBits,
    formula: (c) => `k = ceil(1 / error^2) + 2; bits = ${c.valueBits} x k; standard error = 1 / sqrt(k - 2).`,
  },
  minHash: {
    cls: "MinHash",
    typescript: "minHash",
    python: "min_hash",
    needs: [],
    args: ["k"],
    guide: { use: "You compare how alike two large sets are (documents by their words, users by what they viewed) from a short signature, and need to find near-duplicates.", avoid: "You need an exact similarity, or the sets are small enough to compare directly." },
    size(workload, constants) {
      const s = sizeMinHash(workload, constants);
      return { bits: s.memoryBits, args: { k: s.k }, summary: [`k = ${number(s.k)} slots (${size(s.memoryBits)}) per set`, `an estimated similarity has a standard error of at most ${pct(s.standardError)}`] };
    },
    production: (workload, constants) => sizeMinHash(workload, constants).memoryBits,
    formula: (c) => `k = ceil(1 / (4 error^2)); bits = ${c.valueBits} x k per set; standard error at most 1 / (2 sqrt(k)).`,
  },
  quotientFilter: {
    cls: "QuotientFilter",
    typescript: "quotientFilter",
    python: "quotient_filter",
    needs: [],
    args: ["quotientBits", "remainderBits"],
    guide: { use: "You ask \"have I seen this?\", items must be removable, and you want to merge filters from several machines or keep them compact and cache-friendly.", avoid: "The set can outgrow the table: a full table refuses adds. A Bloom Filter is simpler when nothing is ever removed or merged." },
    size(workload, constants) {
      const lack = missing(workload, "items", "the item count");
      if (lack) return lack;
      const s = sizeQuotient(workload, constants);
      return { bits: s.memoryBits, args: { quotientBits: s.quotientBits, remainderBits: s.remainderBits }, summary: [`${number(s.slots)} slots of ${s.remainderBits + 3} bits (${size(s.memoryBits)})`, `false-positive rate about ${pct(s.falsePositiveRate)}`] };
    },
    production: (workload, constants) => (workload.items === undefined ? null : sizeQuotient(workload, constants).memoryBits),
    formula: () => "quotient bits q = ceil(log2(items / 0.9)); remainder bits r = ceil(log2(load / error)) with load = items / 2^q; bits = 2^q x (r + 3); false-positive rate about load x 2^-r.",
  },
  spectralBloom: {
    cls: "SpectralBloom",
    typescript: "spectralBloom",
    python: "spectral_bloom",
    needs: [],
    args: ["counters", "hashes"],
    guide: { use: "You need both \"have I seen this?\" and \"how many times?\" from one structure, and items must be removable.", avoid: "Counts are huge (16-bit counters stop at 65,535) or memory is tight: a Bloom Filter uses sixteen times fewer bits for the yes or no alone." },
    size(workload, constants) {
      const lack = missing(workload, "items", "the item count");
      if (lack) return lack;
      const s = sizeSpectral(workload, constants);
      return { bits: s.memoryBits, args: { counters: s.counters, hashes: s.hashes }, summary: [`${number(s.counters)} counters of ${constants.spectralCounterBits} bits (${size(s.memoryBits)}) and ${s.hashes} hashes`, `false-positive rate ${pct(s.falsePositiveRate)}; a count overshoots by at most ${pct(s.overshootShare)} of all items added`] };
    },
    production: (workload, constants) => (workload.items === undefined ? null : sizeSpectral(workload, constants).memoryBits),
    formula: (c) => `counters m = -n ln(p) / (ln 2)^2; hashes k = round(m / n x ln 2); bits = ${c.spectralCounterBits} x m; false-positive rate (1 - e^(-k n / m))^k; a count overshoots by at most e k N / m.`,
  },
  scalableBloom: {
    cls: "ScalableBloomFilter",
    typescript: "scalableBloom",
    python: "scalable_bloom",
    needs: ["bloomFilter"],
    args: ["initialCapacity", "falsePositiveRate"],
    guide: { use: "You ask \"have I seen this?\" about a set whose size you cannot know in advance, and want the false-positive rate to stay under a target as it grows.", avoid: "You know the size: a Bloom Filter sized for it needs less memory. Items cannot be removed." },
    size(workload, constants) {
      const lack = missing(workload, "items", "the expected item count");
      if (lack) return lack;
      const s = sizeScalable(workload, constants);
      return { bits: s.memoryBits, args: { initialCapacity: s.initialCapacity, falsePositiveRate: s.falsePositiveRate }, summary: [`a first layer for ${number(s.initialCapacity)} items; about ${s.layers} layers (${size(s.memoryBits)}) for ${number(workload.items as number)} items, more if it grows`, `false-positive rate stays under ${pct(s.falsePositiveRate)}`] };
    },
    production: (workload, constants) => (workload.items === undefined ? null : sizeScalable(workload, constants).memoryBits),
    formula: () => "layer i holds first x 2^i items with a false-positive target of 0.45 x rate x (1/2)^i, so the targets add up to 0.9 of the rate asked for; the first layer holds a seventh of the expected items, so three layers hold them all.",
  },
  simHash: {
    cls: "SimHash",
    typescript: "simHash",
    python: "sim_hash",
    needs: [],
    args: ["planes"],
    guide: { use: "You compare large sets or documents by the angle between them and want a fingerprint a few kilobytes long, where \"roughly alike\" is enough.", avoid: "A few items repeat a lot (the repeats dominate the fingerprint), or you need a close estimate of the Jaccard similarity: MinHash is sharper." },
    size(workload, constants) {
      const s = sizeSimHash(workload, constants);
      return { bits: s.memoryBits, args: { planes: s.planes }, summary: [`${number(s.planes)} planes of ${constants.simHashCounterBits} bits (${size(s.memoryBits)})`, `the angle, as a share of pi, has a standard error of at most ${pct(s.standardError)}`] };
    },
    production: (workload, constants) => sizeSimHash(workload, constants).memoryBits,
    formula: (c) => `planes = ceil(1 / (4 error^2)) rounded up to a multiple of 32; bits = ${c.simHashCounterBits} x planes; the share of planes that disagree has a standard error of at most 1 / (2 sqrt(planes)).`,
  },
};
