import type { Workload } from "@pda/exporter";

/** The export form's fields, as typed. */
export interface WorkloadFields {
  items: string;
  distinct: string;
  /** A percentage: 1 means 1%. */
  errorPercent: string;
  memoryKiB: string;
}

export type ParsedWorkload = { ok: true; workload: Workload } | { ok: false; message: string };

/** One field: blank is "not given", commas and spaces are allowed, anything else must be a positive number. */
function positive(text: string, label: string): number | undefined | string {
  const cleaned = text.replace(/[,\s]/g, "");
  if (cleaned === "") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : `${label} must be a positive number, or left blank.`;
}

export function parseWorkload(fields: WorkloadFields): ParsedWorkload {
  const items = positive(fields.items, "The item count");
  const distinct = positive(fields.distinct, "The number of different items");
  const percent = positive(fields.errorPercent, "The acceptable error");
  const memory = positive(fields.memoryKiB, "The memory budget");
  for (const value of [items, distinct, percent, memory]) if (typeof value === "string") return { ok: false, message: value };
  if (typeof percent === "number" && percent >= 100) return { ok: false, message: "The acceptable error must be under 100%." };
  if (typeof items === "number" && typeof distinct === "number" && distinct > items) return { ok: false, message: "The number of different items cannot be more than the item count." };
  const workload: Workload = {};
  if (typeof items === "number") workload.items = items;
  if (typeof distinct === "number") workload.distinct = distinct;
  if (typeof percent === "number") workload.error = percent / 100;
  if (typeof memory === "number") workload.memoryBits = memory * 1024 * 8;
  return { ok: true, workload };
}
