import { restoreStructure } from "../structures";
import { CountMinSketch } from "../structures/countMinSketch";
import { HyperLogLog } from "../structures/hyperLogLog";
import { LogLog } from "../structures/logLog";
import type { StreamEvent, Structure, StructureConstants, StructureSnapshot } from "../structures/types";

// The Cunning enemy: it searches for values that hurt the structures the player has deployed, using the public hash seed.
//
// What it may read is the state of a deployed structure and the public rules of its hashing. It never reads a structure's own
// seed: `publicModel` takes the seed out of the snapshot first, so a structure with a secret seed (the Seeded enchantment) is read
// as if it hashed with the public one, and what the enemy finds for it is no more harmful than random values.

export interface AttackContext {
  /** The deployed structures as they are now (an empty slot is null). */
  snapshots: readonly (StructureSnapshot | null)[];
  constants: StructureConstants;
  /** The value a Frequency challenge will shield: the heaviest live value. Null when nothing is live. */
  coreValue: number | null;
  /** How many candidate values to look through. */
  budget: number;
  /** The i-th candidate: a value outside the enemy's universe. */
  candidate: (index: number) => number;
}

/** The structure as an enemy that only knows the public seed sees it: the same state, read with the public hashes. */
export function publicModel(snapshot: StructureSnapshot, constants: StructureConstants): Structure {
  const open = { ...snapshot };
  delete open.hashSeed;
  return restoreStructure(open, constants);
}

/** Values that fill a Count-Min row of the core value, in the order that raises its smallest counter: each goes where the core's counters are lowest. */
function againstCountMin(model: CountMinSketch, ctx: AttackContext, wanted: number): number[] {
  const core = ctx.coreValue;
  if (core === null) return [];
  const target = model.probe(core);
  const rows = target.slots.length;
  const byRow: Array<Array<{ value: number; rowsHit: number[] }>> = Array.from({ length: rows }, () => []);
  for (let i = 0; i < ctx.budget; i++) {
    const value = ctx.candidate(i);
    const slots = model.probe(value).slots;
    const rowsHit = slots.flatMap((slot, row) => (slot === target.slots[row] ? [row] : []));
    for (const row of rowsHit) if ((byRow[row] as Array<unknown>).length < wanted) (byRow[row] as Array<{ value: number; rowsHit: number[] }>).push({ value, rowsHit });
  }
  const counters = [...target.counters];
  const used = new Set<number>();
  const out: number[] = [];
  while (out.length < wanted) {
    // The estimate is the smallest counter, so it only rises when that counter does.
    let row = 0;
    for (let r = 1; r < rows; r++) if ((counters[r] as number) < (counters[row] as number)) row = r;
    const pick = (byRow[row] as Array<{ value: number; rowsHit: number[] }>).find((c) => !used.has(c.value));
    if (!pick) break;
    used.add(pick.value);
    out.push(pick.value);
    for (const r of pick.rowsHit) counters[r] = (counters[r] as number) + 1;
  }
  return out;
}

/** For each register, the value that would leave the largest rank there; the largest gains first. */
function againstRegisters(model: LogLog | HyperLogLog, ctx: AttackContext, wanted: number): number[] {
  const best = new Map<number, { value: number; rank: number }>();
  for (let i = 0; i < ctx.budget; i++) {
    const value = ctx.candidate(i);
    const { register, rank, held } = model.probe(value);
    if (rank <= held) continue;
    const current = best.get(register);
    if (!current || rank > current.rank) best.set(register, { value, rank });
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank || a.value - b.value).slice(0, wanted).map((c) => c.value);
}

/**
 * The values the enemy inserts to hurt the player's structures: against Count-Min the values that share its core value's counters,
 * against LogLog and HyperLogLog the values with the rarest hash patterns. `count` values in all, shared out between the structures
 * it can attack in turn. Fewer, or none, when there is nothing to attack.
 */
export function craftInserts(ctx: AttackContext, count: number): StreamEvent[] {
  if (count <= 0) return [];
  const lists: number[][] = [];
  for (const snapshot of ctx.snapshots) {
    if (!snapshot) continue;
    if (snapshot.kind !== "countMinSketch" && snapshot.kind !== "logLog" && snapshot.kind !== "hyperLogLog") continue;
    const model = publicModel(snapshot, ctx.constants);
    if (model instanceof CountMinSketch) lists.push(againstCountMin(model, ctx, count));
    else if (model instanceof LogLog || model instanceof HyperLogLog) lists.push(againstRegisters(model, ctx, count));
  }
  const seen = new Set<number>();
  const out: StreamEvent[] = [];
  for (let position = 0; out.length < count && lists.some((list) => position < list.length); position++) {
    for (const list of lists) {
      const value = list[position];
      if (value === undefined || seen.has(value) || out.length >= count) continue;
      seen.add(value);
      out.push({ op: "insert", value });
    }
  }
  return out;
}

/** The most candidates asked about in one query. */
const CHUNK = 1000;

/**
 * Values that were never inserted but that a deployed filter reports present, as seen with the public seed: false positives the enemy
 * can offer as Presence decoys. Up to `wanted` of them.
 */
export function craftDecoys(ctx: AttackContext, wanted: number): number[] {
  if (wanted <= 0) return [];
  const filters = ctx.snapshots.flatMap((snapshot) => (snapshot && (snapshot.kind === "bloomFilter" || snapshot.kind === "cuckooFilter") ? [publicModel(snapshot, ctx.constants)] : []));
  if (filters.length === 0) return [];
  const found: number[] = [];
  for (let start = 0; start < ctx.budget && found.length < wanted; start += CHUNK) {
    const targets = Array.from({ length: Math.min(CHUNK, ctx.budget - start) }, (_, i) => ctx.candidate(start + i));
    const flagged = new Set<number>();
    for (const filter of filters) {
      const answer = filter.query({ kind: "presence", targets });
      if (answer && Array.isArray(answer.estimate)) for (const value of answer.estimate) flagged.add(value);
    }
    for (const value of targets) if (flagged.has(value) && found.length < wanted) found.push(value);
  }
  return found;
}
