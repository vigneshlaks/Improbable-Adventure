import { BloomFilter } from "./bloomFilter";
import { CountMinSketch } from "./countMinSketch";
import { ExactMemory } from "./exactMemory";
import { LinearCounting } from "./linearCounting";
import { LogLog } from "./logLog";
import { ReservoirSampling } from "./reservoirSampling";
import type { Structure, StructureConstants, StructureKind, StructureOptions } from "./types";

export * from "./types";
export { BloomFilter, bloomFalsePositiveRate, bloomOptimalK, DEFAULT_BITS_PER_ITEM } from "./bloomFilter";
export { CountMinSketch, DEFAULT_CMS_DEPTH } from "./countMinSketch";
export { ExactMemory } from "./exactMemory";
export { LinearCounting } from "./linearCounting";
export { LogLog, LOGLOG_ERROR_COEFFICIENT, MIN_LOGLOG_REGISTERS } from "./logLog";
export { ReservoirSampling } from "./reservoirSampling";

export function createStructure(kind: StructureKind, options: StructureOptions, constants: StructureConstants): Structure {
  switch (kind) {
    case "exactMemory":
      return new ExactMemory(options, constants);
    case "reservoirSampling":
      return new ReservoirSampling(options, constants);
    case "bloomFilter":
      return new BloomFilter(options, constants);
    case "countMinSketch":
      return new CountMinSketch(options, constants);
    case "logLog":
      return new LogLog(options, constants);
    case "linearCounting":
      return new LinearCounting(options, constants);
  }
}
