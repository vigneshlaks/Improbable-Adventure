import type { StructureKind } from "@pda/engine";
import { number, pct, size } from "./format";
import {
  sizeBloom,
  sizeCountMin,
  sizeExact,
  sizeHyperLogLog,
  sizeLinearCounting,
  sizeLogLog,
  sizeReservoir,
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
  /** The template file of each language, without extension, and the helper files it needs besides. */
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
};
