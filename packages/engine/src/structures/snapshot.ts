import type { RngState } from "../rng/rng";
import {
  type Json,
  type StructureKind,
  type StructureOptions,
  type StructureSnapshot,
} from "./types";

// Helpers shared by every structure's snapshot() and fromSnapshot().

type State = StructureSnapshot["state"];

/** The part of a snapshot that is the same for every structure: its kind and the options it was built with. */
export function snapshotHeader(
  kind: StructureKind,
  options: StructureOptions,
): Pick<StructureSnapshot, "kind" | "spaceBits" | "knob" | "hashSeed" | "enchantment"> {
  // Optional fields are left out entirely when unset, so the snapshot survives JSON unchanged.
  return {
    kind,
    spaceBits: options.spaceBits,
    ...(options.knob !== undefined ? { knob: options.knob } : {}),
    ...(options.hashSeed !== undefined ? { hashSeed: options.hashSeed } : {}),
    ...(options.enchantment !== undefined ? { enchantment: options.enchantment } : {}),
  };
}

/** The options needed to rebuild an empty structure of the same shape. */
export function optionsFromSnapshot(snapshot: StructureSnapshot): StructureOptions {
  return {
    spaceBits: snapshot.spaceBits,
    ...(snapshot.knob !== undefined ? { knob: snapshot.knob } : {}),
    ...(snapshot.hashSeed !== undefined ? { hashSeed: snapshot.hashSeed } : {}),
    ...(snapshot.enchantment !== undefined ? { enchantment: snapshot.enchantment } : {}),
  };
}

export function expectKind(snapshot: StructureSnapshot, kind: StructureKind): void {
  if (snapshot.kind !== kind) throw new RangeError(`Bad snapshot: expected a ${kind}, got ${String(snapshot.kind)}`);
}

export function readNumber(state: State, key: string): number {
  const value: Json | undefined = state[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`Bad snapshot: "${key}" must be a finite number`);
  }
  return value;
}

/** A list of non-negative integers, optionally required to have an exact length. */
export function readCounts(state: State, key: string, length?: number): number[] {
  const value: Json | undefined = state[key];
  if (!Array.isArray(value)) throw new RangeError(`Bad snapshot: "${key}" must be an array`);
  if (length !== undefined && value.length !== length) {
    throw new RangeError(`Bad snapshot: "${key}" must have ${length} entries, got ${value.length}`);
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      throw new RangeError(`Bad snapshot: "${key}" must hold non-negative integers`);
    }
  }
  return value as number[];
}

/** The seeded random generator's saved position. */
export function readRngState(state: State): RngState {
  const value: Json | undefined = state.rng;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError('Bad snapshot: "rng" must be an object');
  }
  if (typeof value.seedKey !== "string") throw new RangeError('Bad snapshot: "rng.seedKey" must be a string');
  return {
    seedKey: value.seedKey,
    a: readNumber(value, "a"),
    b: readNumber(value, "b"),
    c: readNumber(value, "c"),
    d: readNumber(value, "d"),
  };
}
