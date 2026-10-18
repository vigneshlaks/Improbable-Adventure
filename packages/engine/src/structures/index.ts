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
  }
}
