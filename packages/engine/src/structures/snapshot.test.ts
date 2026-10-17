import { describe, expect, it } from "vitest";
import { Rng } from "../rng/rng";
import { eachCase } from "../testCases";
import {
  createStructure,
  restoreStructure,
  type Challenge,
  type StreamEvent,
  type Structure,
  type StructureKind,
  type StructureOptions,
  type StructureSnapshot,
} from "./index";
import { distinctValues, TEST_CONSTANTS, trialRng } from "./testUtils";

// Every structure, sized small enough that the tests exercise full tables and crowded filters.
const CASES: Array<{ kind: StructureKind; options: StructureOptions }> = [
  { kind: "exactMemory", options: { spaceBits: 64 * 50 } },
  { kind: "reservoirSampling", options: { spaceBits: 32 * 40, rng: Rng.fromSeed("snapshot-reservoir") } },
  { kind: "bloomFilter", options: { spaceBits: 2048, knob: 200, hashSeed: 12345 } },
  { kind: "countMinSketch", options: { spaceBits: 4096, knob: 4, hashSeed: 12345 } },
  { kind: "logLog", options: { spaceBits: 640, hashSeed: 12345 } },
  { kind: "linearCounting", options: { spaceBits: 1024, hashSeed: 12345 } },
  { kind: "hyperLogLog", options: { spaceBits: 640, hashSeed: 12345 } },
  // The enchanted variants: Count-Min with Conservative Update, SuperLogLog.
  { kind: "countMinSketch", options: { spaceBits: 4500, knob: 4, hashSeed: 12345, enchantment: "steady" } },
  { kind: "logLog", options: { spaceBits: 800, hashSeed: 12345, enchantment: "steady" } },
];

const UNIVERSE = distinctValues(trialRng("snapshot-universe", 0), 300);

/** A mix of inserts and deletes, deleting only values that are currently live. */
function makeEvents(rng: Rng, live: Map<number, number>, count: number): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (let i = 0; i < count; i++) {
    const value = UNIVERSE[rng.int(UNIVERSE.length)] ?? 0;
    const current = live.get(value) ?? 0;
    if (current > 0 && rng.float() < 0.2) {
      events.push({ op: "delete", value });
      live.set(value, current - 1);
    } else {
      events.push({ op: "insert", value });
      live.set(value, current + 1);
    }
  }
  return events;
}

function ingestAll(structures: Structure[], events: StreamEvent[]): void {
  for (const event of events) for (const s of structures) s.ingest(event);
}

/** One question of each kind; structures that cannot answer a kind return null. */
const PROBES: Challenge[] = [
  { kind: "presence", targets: UNIVERSE.slice(0, 12) },
  { kind: "frequency", value: UNIVERSE[0] ?? 0 },
  { kind: "count" },
];
const answers = (s: Structure) => PROBES.map((probe) => s.query(probe));

const viaJson = (snapshot: StructureSnapshot): StructureSnapshot => JSON.parse(JSON.stringify(snapshot));

describe("snapshots, for every structure", () => {
  /** Runs a check on each structure, reporting every one that fails. */
  const forEvery = (check: (c: { kind: StructureKind; options: StructureOptions; build: () => Structure }) => void) =>
    eachCase(CASES.map((c) => [c.kind, c] as const), ({ kind, options }) =>
      check({ kind, options, build: () => createStructure(kind, options, TEST_CONSTANTS) }),
    );

  it("is plain data that survives JSON unchanged", () => {
    forEvery(({ kind, build }) => {
      const s = build();
      ingestAll([s], makeEvents(trialRng("snap-json", 0), new Map(), 600));
      const snapshot = s.snapshot();
      expect(snapshot.kind).toBe(kind);
      expect(viaJson(snapshot)).toStrictEqual(snapshot);
    });
  });

  it("restores to a structure that looks and answers the same", () => {
    forEvery(({ kind, build }) => {
      const original = build();
      ingestAll([original], makeEvents(trialRng("snap-restore", 0), new Map(), 600));
      const restored = restoreStructure(viaJson(original.snapshot()), TEST_CONSTANTS);

      expect(restored.kind).toBe(kind);
      expect(restored.params).toEqual(original.params);
      expect(restored.spaceBits()).toBe(original.spaceBits());
      expect(restored.snapshot()).toStrictEqual(original.snapshot());
      expect(answers(restored)).toEqual(answers(original));
    });
  });

  it("keeps behaving identically as more events arrive", () => {
    forEvery(({ build }) => {
      const rng = trialRng("snap-continue", 0);
      const live = new Map<number, number>();
      const original = build();
      ingestAll([original], makeEvents(rng, live, 400));
      const restored = restoreStructure(viaJson(original.snapshot()), TEST_CONSTANTS);

      // Including sampling: a restored Reservoir must continue its random choices from the same point.
      ingestAll([original, restored], makeEvents(rng, live, 600));
      expect(restored.snapshot()).toStrictEqual(original.snapshot());
      expect(answers(restored)).toEqual(answers(original));
    });
  });

  it("can restore an empty structure", () => {
    forEvery(({ build }) => {
      const empty = build();
      const restored = restoreStructure(viaJson(empty.snapshot()), TEST_CONSTANTS);
      expect(restored.snapshot()).toStrictEqual(empty.snapshot());
    });
  });

  it("is a copy, not a view of the live structure", () => {
    forEvery(({ build }) => {
      const s = build();
      ingestAll([s], makeEvents(trialRng("snap-copy", 0), new Map(), 300));
      const snapshot = s.snapshot();
      const frozen = JSON.stringify(snapshot);
      ingestAll([s], makeEvents(trialRng("snap-copy", 1), new Map(), 300));
      expect(JSON.stringify(snapshot)).toBe(frozen);
      expect(JSON.stringify(s.snapshot())).not.toBe(frozen);
    });
  });

  it("rejects a snapshot with missing or malformed state", () => {
    forEvery(({ build }) => {
      const snapshot = build().snapshot();
      expect(() => restoreStructure({ ...snapshot, state: {} }, TEST_CONSTANTS)).toThrow(RangeError);
      const firstKey = Object.keys(snapshot.state)[0] as string;
      expect(() => restoreStructure({ ...snapshot, state: { ...snapshot.state, [firstKey]: "oops" } }, TEST_CONSTANTS)).toThrow(RangeError);
    });
  });

  it("rejects a snapshot whose kind does not match its state", () => {
    forEvery(({ kind, build }) => {
      const other = CASES.find((c) => c.kind !== kind) as (typeof CASES)[number];
      const foreign = createStructure(other.kind, other.options, TEST_CONSTANTS).snapshot();
      expect(() => restoreStructure({ ...build().snapshot(), state: foreign.state }, TEST_CONSTANTS)).toThrow(RangeError);
    });
  });
});

describe("snapshot validation", () => {
  it("rejects an array of the wrong length", () => {
    const snapshot = createStructure("bloomFilter", { spaceBits: 2048, knob: 200 }, TEST_CONSTANTS).snapshot();
    const bits = snapshot.state.bits as number[];
    expect(() => restoreStructure({ ...snapshot, state: { ...snapshot.state, bits: bits.slice(1) } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  it("rejects non-integer or negative array entries", () => {
    const snapshot = createStructure("countMinSketch", { spaceBits: 4096 }, TEST_CONSTANTS).snapshot();
    const counters = [...(snapshot.state.counters as number[])];
    counters[0] = -1;
    expect(() => restoreStructure({ ...snapshot, state: { ...snapshot.state, counters } }, TEST_CONSTANTS)).toThrow(RangeError);
    counters[0] = 1.5;
    expect(() => restoreStructure({ ...snapshot, state: { ...snapshot.state, counters } }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  it("rejects an unknown kind", () => {
    const snapshot = createStructure("logLog", { spaceBits: 640 }, TEST_CONSTANTS).snapshot();
    expect(() => restoreStructure({ ...snapshot, kind: "skipList" as StructureKind }, TEST_CONSTANTS)).toThrow(RangeError);
  });

  it("restores a Bloom filter that still merges with the original", () => {
    const original = createStructure("bloomFilter", { spaceBits: 2048, knob: 200, hashSeed: 7 }, TEST_CONSTANTS);
    const restored = restoreStructure(viaJson(original.snapshot()), TEST_CONSTANTS);
    expect(() => original.merge?.(restored)).not.toThrow();
  });
});
