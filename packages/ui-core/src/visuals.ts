import { BloomFilter, CountMinSketch, CountSketch, HyperLogLog, LogLog, restoreStructure, TopKTracker, type Json, type StructureConstants, type StructureSnapshot } from "@pda/engine";
import { structureLabel } from "./views";

/** The most cells a visual draws; a bigger structure is shown averaged down to this many. */
export const MAX_VISUAL_CELLS = 256;

/**
 * What the side panel draws for one deployed structure. Every value is between 0 and 1.
 * A meter is a strip of cells (how full each part is), a heatmap is a grid with `columns` per row,
 * bars are one per register. Nothing here is needed to play: `caption` and `readout` say the same in words.
 */
export interface StructureVisual {
  slot: number;
  label: string;
  shape: "meter" | "heatmap" | "bars";
  cells: number[];
  columns: number;
  /** What the cells are. */
  caption: string;
  /** Live numbers, including the structure's own error estimate where it has one. */
  readout: string;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;
const numbers = (state: StructureSnapshot["state"], key: string): number[] => {
  const value: Json | undefined = state[key];
  return Array.isArray(value) ? (value as number[]) : [];
};

/** Averages a list down to at most `limit` cells, keeping its order. */
export function downsample(values: number[], limit = MAX_VISUAL_CELLS): number[] {
  if (values.length <= limit) return values;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    const from = Math.floor((i * values.length) / limit);
    const to = Math.floor(((i + 1) * values.length) / limit);
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j] ?? 0;
    out.push(sum / (to - from));
  }
  return out;
}

/** Bit i of a list of 32-bit words (little end first) or of bytes, as 0 or 1. */
function unpackBits(words: number[], count: number, wordBits: number): number[] {
  return Array.from({ length: count }, (_, i) => ((words[Math.floor(i / wordBits)] ?? 0) >>> i % wordBits) & 1);
}

export function structureVisual(snapshot: StructureSnapshot, slot: number, constants: StructureConstants): StructureVisual {
  const live = restoreStructure(snapshot, constants);
  const { state } = snapshot;
  const base = { slot, label: structureLabel(snapshot.kind, snapshot.enchantment) };

  if (live instanceof BloomFilter) {
    const m = live.params.m as number;
    return { ...base, shape: "meter", cells: downsample(unpackBits(numbers(state, "bits"), m, 32)), columns: 0, caption: "bit array (lit = set)", readout: `${percent(live.fill)} full, false positives about ${percent(live.currentFalsePositiveRate())}` };
  }
  if (live instanceof CountMinSketch) {
    const counters = numbers(state, "counters");
    const peak = Math.max(1, ...counters);
    const { width, depth } = live.params as { width: number; depth: number };
    return { ...base, shape: "heatmap", cells: counters.map((c) => c / peak), columns: width, caption: `${depth} rows of ${width} counters (brighter = higher)`, readout: `overshoot about ${live.errorBand.toFixed(1)} over ${live.liveTotal} values` };
  }
  if (live instanceof CountSketch) {
    const counters = numbers(state, "counters").map((c) => Math.abs(c - 2 ** 31)); // stored with an offset; the size of a counter is what shows
    const peak = Math.max(1, ...counters);
    const { width, depth } = live.params as { width: number; depth: number };
    return { ...base, shape: "heatmap", cells: counters.map((c) => c / peak), columns: width, caption: `${depth} rows of ${width} signed counters (brighter = larger, either way)`, readout: `error about ±${live.errorBand.toFixed(1)} either way` };
  }
  if (live instanceof TopKTracker) {
    const grid = (state.grid as { state: StructureSnapshot["state"] }).state;
    const counters = numbers(grid, "counters");
    const peak = Math.max(1, ...counters);
    const { width, depth, candidates } = live.params as { width: number; depth: number; candidates: number };
    const heaviest = live.candidates[0];
    return {
      ...base,
      shape: "heatmap",
      cells: counters.map((c) => c / peak),
      columns: width,
      caption: `${depth} rows of ${width} counters, and a list of the ${candidates} heaviest values`,
      readout: heaviest ? `${live.candidates.length} of ${candidates} listed; the heaviest is between ${heaviest.low} and ${heaviest.high}` : `0 of ${candidates} listed`,
    };
  }
  if (live instanceof LogLog || live instanceof HyperLogLog) {
    const registers = numbers(state, "registers");
    const peak = Math.max(1, ...registers);
    return { ...base, shape: "bars", cells: downsample(registers.map((r) => r / peak)), columns: 0, caption: `${registers.length} registers (taller = rarer pattern seen)`, readout: `error about ±${percent(live.standardError)}` };
  }
  if (snapshot.kind === "linearCounting") {
    const m = live.params.m as number;
    const bits = unpackBits(numbers(state, "bits"), m, 8);
    const full = bits.reduce((a, b) => a + b, 0) / m;
    return { ...base, shape: "meter", cells: downsample(bits), columns: 0, caption: "bit array (lit = set)", readout: `${percent(full)} full` };
  }
  if (snapshot.kind === "bloomFilter") {
    // A Stable Bloom Filter: cells count down as the stream goes by.
    const cells = numbers(state, "cells");
    const max = live.params.cellMax as number;
    const used = cells.filter((c) => c > 0).length / Math.max(1, cells.length);
    return { ...base, shape: "meter", cells: downsample(cells.map((c) => c / max)), columns: 0, caption: "cells (brighter = seen more recently)", readout: `${percent(used)} of cells in use` };
  }
  if (snapshot.kind === "exactMemory") {
    const capacity = live.params.capacity as number;
    const stored = numbers(state, "entries").length / 2;
    return { ...base, shape: "meter", cells: Array.from({ length: Math.min(capacity, MAX_VISUAL_CELLS) }, (_, i) => (i < (stored * Math.min(capacity, MAX_VISUAL_CELLS)) / capacity ? 1 : 0)), columns: 0, caption: "table entries (lit = used)", readout: `${stored} of ${capacity} entries used` };
  }
  const slots = live.params.slots as number;
  const held = numbers(state, "sample").length;
  return { ...base, shape: "meter", cells: Array.from({ length: Math.min(slots, MAX_VISUAL_CELLS) }, (_, i) => (i < (held * Math.min(slots, MAX_VISUAL_CELLS)) / slots ? 1 : 0)), columns: 0, caption: "sample slots (lit = held)", readout: `${held} of ${slots} slots held, ${state.seen as number} seen` };
}
