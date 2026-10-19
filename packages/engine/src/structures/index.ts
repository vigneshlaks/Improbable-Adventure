import { BloomFilter } from "./bloomFilter";
import { CountMinSketch } from "./countMinSketch";
import { CountSketch } from "./countSketch";
import { CuckooFilter } from "./cuckooFilter";
import { TopKTracker } from "./topKTracker";
import { ExactMemory } from "./exactMemory";
import { HyperLogLog } from "./hyperLogLog";
import { KllSketch } from "./kllSketch";
import { KMinimumValues } from "./kMinimumValues";
import { LinearCounting } from "./linearCounting";
import { LogLog } from "./logLog";
import { StableBloomFilter } from "./stableBloomFilter";
import { DyadicCountMin } from "./dyadicCountMin";
import { HyperMinHash } from "./hyperMinHash";
import { LocalitySensitiveHash } from "./localitySensitiveHash";
import { MinHash } from "./minHash";
import { QuotientFilter } from "./quotientFilter";
import { SimHash } from "./simHash";
import { ScalableBloom } from "./scalableBloom";
import { SpectralBloom } from "./spectralBloom";
import { TDigest } from "./tDigest";
import { ReservoirSampling } from "./reservoirSampling";
import { FADING, type Structure, type StructureConstants, type StructureKind, type StructureOptions, type StructureSnapshot } from "./types";

export * from "./types";
export { BloomFilter, bloomFalsePositiveRate, bloomOptimalK, DEFAULT_BITS_PER_ITEM } from "./bloomFilter";
export { CountMinSketch } from "./countMinSketch";
export { CountSketch } from "./countSketch";
export { CuckooFilter } from "./cuckooFilter";
export { TopKTracker, type Candidate } from "./topKTracker";
export { ExactMemory } from "./exactMemory";
export { HyperLogLog, MIN_HLL_REGISTERS } from "./hyperLogLog";
export { KllSketch } from "./kllSketch";
export { DyadicCountMin } from "./dyadicCountMin";
export { HyperMinHash } from "./hyperMinHash";
export { LocalitySensitiveHash } from "./localitySensitiveHash";
export { MinHash } from "./minHash";
export { QuotientFilter } from "./quotientFilter";
export { SimHash } from "./simHash";
export { ScalableBloom } from "./scalableBloom";
export { SpectralBloom } from "./spectralBloom";
export { TDigest } from "./tDigest";
export { KMinimumValues } from "./kMinimumValues";
export { LinearCounting } from "./linearCounting";
export { LogLog, MIN_LOGLOG_REGISTERS } from "./logLog";
export { ReservoirSampling } from "./reservoirSampling";
export { forgetProbability, stableDecrements, StableBloomFilter } from "./stableBloomFilter";

/** Rebuilds a live structure from a snapshot. Throws a RangeError if the snapshot is malformed. */
export function restoreStructure(snapshot: StructureSnapshot, constants: StructureConstants): Structure {
  switch (snapshot.kind) {
    case "exactMemory":
      return ExactMemory.fromSnapshot(snapshot, constants);
    case "reservoirSampling":
      return ReservoirSampling.fromSnapshot(snapshot, constants);
    case "bloomFilter":
      return snapshot.enchantment === FADING ? StableBloomFilter.fromSnapshot(snapshot, constants) : BloomFilter.fromSnapshot(snapshot, constants);
    case "countMinSketch":
      return CountMinSketch.fromSnapshot(snapshot, constants);
    case "logLog":
      return LogLog.fromSnapshot(snapshot, constants);
    case "linearCounting":
      return LinearCounting.fromSnapshot(snapshot, constants);
    case "hyperLogLog":
      return HyperLogLog.fromSnapshot(snapshot, constants);
    case "countSketch":
      return CountSketch.fromSnapshot(snapshot, constants);
    case "topKTracker":
      return TopKTracker.fromSnapshot(snapshot, constants);
    case "cuckooFilter":
      return CuckooFilter.fromSnapshot(snapshot, constants);
    case "kMinimumValues":
      return KMinimumValues.fromSnapshot(snapshot, constants);
    case "kllSketch":
      return KllSketch.fromSnapshot(snapshot, constants);
    case "tDigest":
      return TDigest.fromSnapshot(snapshot, constants);
    case "minHash":
      return MinHash.fromSnapshot(snapshot, constants);
    case "scalableBloom":
      return ScalableBloom.fromSnapshot(snapshot, constants);
    case "spectralBloom":
      return SpectralBloom.fromSnapshot(snapshot, constants);
    case "dyadicCountMin":
      return DyadicCountMin.fromSnapshot(snapshot, constants);
    case "quotientFilter":
      return QuotientFilter.fromSnapshot(snapshot, constants);
    case "simHash":
      return SimHash.fromSnapshot(snapshot, constants);
    case "lsh":
      return LocalitySensitiveHash.fromSnapshot(snapshot, constants);
    case "hyperMinHash":
      return HyperMinHash.fromSnapshot(snapshot, constants);
    default:
      throw new RangeError(`Cannot restore unknown structure kind: ${String((snapshot as { kind: unknown }).kind)}`);
  }
}

export function createStructure(kind: StructureKind, options: StructureOptions, constants: StructureConstants): Structure {
  switch (kind) {
    case "exactMemory":
      return new ExactMemory(options, constants);
    case "reservoirSampling":
      return new ReservoirSampling(options, constants);
    case "bloomFilter":
      return options.enchantment === FADING ? new StableBloomFilter(options, constants) : new BloomFilter(options, constants);
    case "countMinSketch":
      return new CountMinSketch(options, constants);
    case "logLog":
      return new LogLog(options, constants);
    case "linearCounting":
      return new LinearCounting(options, constants);
    case "hyperLogLog":
      return new HyperLogLog(options, constants);
    case "countSketch":
      return new CountSketch(options, constants);
    case "topKTracker":
      return new TopKTracker(options, constants);
    case "cuckooFilter":
      return new CuckooFilter(options, constants);
    case "kMinimumValues":
      return new KMinimumValues(options, constants);
    case "kllSketch":
      return new KllSketch(options, constants);
    case "tDigest":
      return new TDigest(options, constants);
    case "minHash":
      return new MinHash(options, constants);
    case "scalableBloom":
      return new ScalableBloom(options, constants);
    case "spectralBloom":
      return new SpectralBloom(options, constants);
    case "dyadicCountMin":
      return new DyadicCountMin(options, constants);
    case "quotientFilter":
      return new QuotientFilter(options, constants);
    case "simHash":
      return new SimHash(options, constants);
    case "lsh":
      return new LocalitySensitiveHash(options, constants);
    case "hyperMinHash":
      return new HyperMinHash(options, constants);
  }
}
