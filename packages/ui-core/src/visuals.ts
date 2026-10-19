import { BloomFilter, DyadicCountMin, HyperMinHash, LocalitySensitiveHash, CountMinSketch, CountSketch, CuckooFilter, HyperLogLog, KllSketch, KMinimumValues, LogLog, MinHash, QuotientFilter, restoreStructure, ScalableBloom, SimHash, SpectralBloom, TDigest, TopKTracker, type Json, type StructureConstants, type StructureSnapshot } from "@pda/engine";
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
  if (live instanceof CuckooFilter) {
    const table = numbers(state, "table").map((fingerprint) => (fingerprint > 0 ? 1 : 0));
    const lost = live.lost > 0 ? `, ${live.lost} dropped` : "";
    return { ...base, shape: "meter", cells: downsample(table), columns: 0, caption: "fingerprint places (lit = taken)", readout: `${percent(live.load)} full, false alarms about ${percent(live.falsePositiveRate())}${lost}` };
  }
  if (live instanceof KMinimumValues) {
    const k = live.params.k as number;
    return { ...base, shape: "bars", cells: downsample(live.hashes.map((h) => h / 2 ** 32)), columns: 0, caption: `the ${live.size} smallest of ${k} possible hashes (taller = larger)`, readout: live.size < k ? `${live.size} of ${k} kept: an exact count so far` : `error about ±${percent(live.standardError)}` };
  }
  if (live instanceof KllSketch) {
    const items = live.items;
    const top = Math.max(1, ...items.map((item) => item.weight));
    // Each bar is a stored item: how tall is how many units it stands for (taller = more), in the order of the values.
    return { ...base, shape: "bars", cells: downsample(items.map((item) => item.weight / top)), columns: 0, caption: `${items.length} stored values, each as tall as the units it stands for`, readout: `rank error about ±${percent(live.rankError)}` };
  }
  if (live instanceof LocalitySensitiveHash) {
    const k = live.params.slots as number;
    return { ...base, shape: "bars", cells: downsample(live.signature.map((m) => 1 - m / 2 ** 32)), columns: 0, caption: `${k} minima, read in bands of rows that must all agree (taller = a smaller hash)`, readout: `bands of ${live.rowsFor(0.6)} rows at the usual threshold` };
  }
  if (live instanceof HyperMinHash) {
    const registers = numbers(state, "registers");
    const peak = Math.max(1, ...registers);
    return { ...base, shape: "bars", cells: downsample(registers.map((r) => r / peak)), columns: 0, caption: `${registers.length} registers (taller = a smaller hash in the bucket)`, readout: `about ${Math.round(live.distinctEver(0.95).estimate)} different values, similarity error about ±${percent(0.5 / Math.sqrt(registers.length))}` };
  }
  if (live instanceof QuotientFilter) {
    const slots = live.params.slots as number;
    const cells = Math.min(slots, MAX_VISUAL_CELLS);
    const lit = Math.round(live.load * cells);
    return { ...base, shape: "meter", cells: Array.from({ length: cells }, (_, i) => (i < lit ? 1 : 0)), columns: 0, caption: "slots (lit = holds a fingerprint)", readout: `${percent(live.load)} full, false alarms about ${percent(live.falsePositiveRate())}${live.lost > 0 ? `, ${live.lost} dropped` : ""}` };
  }
  if (live instanceof SimHash) {
    const counters = live.counterValues.map((c) => Math.abs(c));
    const peak = Math.max(1, ...counters);
    return { ...base, shape: "bars", cells: downsample(counters.map((c) => c / peak)), columns: 0, caption: `${counters.length} planes (taller = a stronger lean to one sign)`, readout: `about ${live.effectiveSize().toFixed(0)} values seen as the planes count them` };
  }
  if (live instanceof DyadicCountMin) {
    const counts = live.bucketCounts();
    const peak = Math.max(1, ...counts);
    return { ...base, shape: "bars", cells: downsample(counts.map((c) => c / peak)), columns: 0, caption: `${counts.length} buckets of the value range, in order (taller = more units)`, readout: `quantile error about ±${live.liveTotal > 0 ? percent(Math.min(1, live.errorBand / live.liveTotal)) : "0%"}` };
  }
  if (live instanceof ScalableBloom) {
    const fills = live.layerFills;
    return { ...base, shape: "meter", cells: fills, columns: 0, caption: `${fills.length} layers (lit = how full), ${live.reserveBits} bits still in reserve`, readout: `false positives about ${percent(live.falsePositiveRate())}` };
  }
  if (live instanceof SpectralBloom) {
    const counters = numbers(state, "counters");
    const peak = Math.max(1, ...counters);
    return { ...base, shape: "heatmap", cells: downsample(counters.map((c) => c / peak)), columns: 32, caption: `${counters.length} counters shared by all ${live.params.k} hashes (brighter = higher)`, readout: `overshoot about ${live.errorBand.toFixed(1)}, false positives about ${percent(live.falsePositiveRate)}` };
  }
  if (live instanceof MinHash) {
    const k = live.params.k as number;
    // One bar per slot: how small its minimum hash is (taller = smaller). More values seen pull every minimum down.
    return { ...base, shape: "bars", cells: downsample(live.signature.map((m) => 1 - m / 2 ** 32)), columns: 0, caption: `${k} minima, one per hash function (taller = a smaller hash)`, readout: `similarity error about ±${percent(1 / (2 * Math.sqrt(k)))}` };
  }
  if (live instanceof TDigest) {
    const centroids = live.summary;
    const top = Math.max(1, ...centroids.map((c) => c.weight));
    // Each bar is a centroid: how tall is how many units it stands for. They are small at both ends and large in the middle.
    return { ...base, shape: "bars", cells: downsample(centroids.map((c) => c.weight / top)), columns: 0, caption: `${centroids.length} centroids, each as tall as the units it stands for`, readout: `rank error about ±${percent(live.rankError(0.5))} in the middle, ±${percent(live.rankError(0.99))} at the 99th percentile` };
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
