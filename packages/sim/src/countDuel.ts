import { LinearCounting, LogLog, murmur3String, type LiveSnapshot, type StructureConstants } from "@pda/engine";

/** How far each Count structure's estimate was from the truth, as a share of the truth. */
export interface CounterErrors {
  logLog: number;
  linearCounting: number;
}

/** Every value the enemy has inserted so far, once each: the live values and the ghosts. Both counters saw all of them. */
export function everSeen(live: LiveSnapshot): number[] {
  return [...new Set([...live.items, ...live.ghosts])];
}

/**
 * Feeds the same values to a LogLog and a Linear Counting that were given the same Space, and returns how far
 * each estimate is from `truth`. Neither counter can delete, so their estimates ignore deletes entirely and
 * showing them each value once is the same as showing them the whole stream.
 */
export function counterErrors(values: Iterable<number>, truth: number, spaceBits: number, constants: StructureConstants): CounterErrors {
  if (!(truth > 0)) throw new RangeError(`The truth must be positive, got ${truth}`);
  const logLog = new LogLog({ spaceBits }, constants);
  const linearCounting = new LinearCounting({ spaceBits }, constants);
  for (const value of values) {
    logLog.ingest({ op: "insert", value });
    linearCounting.ingest({ op: "insert", value });
  }
  const relative = (counter: LogLog | LinearCounting) => Math.abs((counter.query({ kind: "count" })?.estimate as number) - truth) / truth;
  return { logLog: relative(logLog), linearCounting: relative(linearCounting) };
}

export interface ErrorRow {
  distinct: number;
  /** Root-mean-square relative error over the trials. */
  logLogRms: number;
  linearCountingRms: number;
  /** Share of trials in which LogLog's estimate was strictly closer. */
  logLogCloserShare: number;
}

/** `distinct` different values, spread over the uint32 range, different for every trial. */
function trialValues(distinct: number, trial: number): number[] {
  const offset = murmur3String(`count-duel/${distinct}/${trial}`);
  return Array.from({ length: distinct }, (_, i) => (Math.imul(i + 1, 2654435761) + offset) >>> 0);
}

/** Measures both counters, at equal Space, on streams of each size with only new values and no deletes. */
export function countErrorTable(sizes: number[], trials: number, spaceBits: number, constants: StructureConstants): ErrorRow[] {
  return sizes.map((distinct) => {
    let logLogSquares = 0;
    let linearSquares = 0;
    let logLogCloser = 0;
    for (let trial = 0; trial < trials; trial++) {
      const errors = counterErrors(trialValues(distinct, trial), distinct, spaceBits, constants);
      logLogSquares += errors.logLog ** 2;
      linearSquares += errors.linearCounting ** 2;
      if (errors.logLog < errors.linearCounting) logLogCloser++;
    }
    return {
      distinct,
      logLogRms: Math.sqrt(logLogSquares / trials),
      linearCountingRms: Math.sqrt(linearSquares / trials),
      logLogCloserShare: logLogCloser / trials,
    };
  });
}
