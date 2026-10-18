import { murmur3String } from "@pda/engine";
import balanceJson from "../balance.json";
import enchantmentsJson from "../enchantments.json";
import fusionsJson from "../fusions.json";
import traitsJson from "../traits.json";
import upgradesJson from "../upgrades.json";

/** JSON with every object's keys in order, so the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 64 bits of hash (two Murmur3 passes with different seeds) of the files' names and contents. It identifies the content; it is not a security measure. */
export function hashContent(files: Record<string, unknown>): string {
  const text = canonicalJson(files);
  const part = (seed: number) => murmur3String(text, seed).toString(16).padStart(8, "0");
  return part(0x9747b28c) + part(0x1b873593);
}

/** The balance numbers that set the rules: everything except the exporter's own settings (`EXPORT_*`), which no run depends on. */
const rulesBalance = (): Record<string, unknown> => Object.fromEntries(Object.entries(balanceJson).filter(([key]) => !key.startsWith("EXPORT_")));

/**
 * A hash of the content that sets the rules: the balance numbers (without the exporter's settings), the stream traits, and the fusions, enchantments and
 * upgrades. The text of structures and narration is left out, so rewording a help line does not invalidate a recorded run.
 */
export function contentHash(overrides: Record<string, unknown> = {}): string {
  return hashContent({
    balance: rulesBalance(),
    traits: traitsJson,
    fusions: fusionsJson,
    enchantments: enchantmentsJson,
    upgrades: upgradesJson,
    ...overrides,
  });
}
