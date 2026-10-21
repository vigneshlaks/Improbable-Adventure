import { enchantments, fusions, structures, upgrades } from "@pda/content";
import type { Observation, RunObservation, StructureKind } from "@pda/engine";
import { formatNumber } from "./narrator";

// What a player can press right now. The page turns a key into the option's command (the same text the terminal takes) or into
// the option's next step, so everything the keys do goes through the parser and the rules, never around them.

/** A step of a choice that takes more than one key: which structure, then how big, and so on. */
export type Pending =
  | null
  | { step: "size"; kind: StructureKind }
  | { step: "knob"; kind: StructureKind; bits: number }
  | { step: "enemy"; kind: StructureKind; bits: number; knob?: number }
  | { step: "remove" }
  | { step: "targets"; picked: number[] };

export interface MenuOption {
  /** The key that chooses it: a digit or a letter, or "Enter". */
  key: string;
  label: string;
  /** A second line: what it does, or why it is not available. */
  detail?: string;
  /** The line the terminal would take. */
  command?: string;
  /** The step this key leads to instead of a command. */
  next?: Pending;
  /** Why it cannot be chosen now. */
  disabled?: string;
  /** True when the screen already shows it as something to press (a target token), so the key list leaves it out. */
  shown?: boolean;
}

export interface Menu {
  heading: string;
  options: MenuOption[];
  /** A number the player may type instead: its label, and what it leads to (a command or the next step). */
  entry?: { label: string; apply(value: string): Pick<MenuOption, "command" | "next"> };
  /** True when Escape goes back one step. */
  cancellable: boolean;
}

/** Keys for a list of choices, in order. Letters the menus use for their own actions are left out. */
const LIST_KEYS = "123456789abcdfgijkmnopqrsuvwyz";
const key = (index: number): string => LIST_KEYS[index] ?? "";

const alias = (kind: StructureKind): string => structures[kind].aliases[0] as string;

/** The share of the free Space each size key offers. */
const SIZE_SHARES: ReadonlyArray<[string, number]> = [
  ["an eighth", 1 / 8],
  ["a quarter", 1 / 4],
  ["half", 1 / 2],
  ["all", 1],
];

/** A whole number of bits for a share of the free Space (a multiple of 64 when that leaves something). */
export function sizeFor(free: number, share: number): number {
  const bits = Math.floor(free * share);
  return bits >= 64 ? bits - (bits % 64) : Math.max(1, bits);
}

function deployCommand(kind: StructureKind, bits: number, knob?: number, enemy?: 0 | 1): string {
  return `deploy ${alias(kind)} ${bits}${knob === undefined ? "" : ` ${knob}`}${enemy === undefined ? "" : ` on ${enemy + 1}`}`;
}

/** Where a size or knob choice goes next: another step, or the command. */
function afterSize(fight: Observation, kind: StructureKind, bits: number, knob?: number): Pick<MenuOption, "command" | "next"> {
  if (fight.secondTraits) return { next: { step: "enemy", kind, bits, ...(knob === undefined ? {} : { knob }) } };
  return { command: deployCommand(kind, bits, knob) };
}

function deployMenu(run: RunObservation, fight: Observation, pending: Pending): Menu {
  if (pending?.step === "size") {
    const info = structures[pending.kind];
    const go = (bits: number): Pick<MenuOption, "command" | "next"> => (info.knob ? { next: { step: "knob", kind: pending.kind, bits } } : afterSize(fight, pending.kind, bits));
    return {
      heading: `${info.name}: how much Space? (${formatNumber(fight.spaceFree)} bits free)`,
      options: SIZE_SHARES.map(([name, share], i) => ({ key: key(i), label: `${name} of what is free`, detail: `${formatNumber(sizeFor(fight.spaceFree, share))} bits`, ...go(sizeFor(fight.spaceFree, share)) })),
      entry: { label: "or type the bits", apply: (value) => go(Number(value)) },
      cancellable: true,
    };
  }
  if (pending?.step === "knob") {
    const info = structures[pending.kind];
    const knob = info.knob as NonNullable<typeof info.knob>;
    const spread = knob.max / Math.max(1, knob.min) > 100; // a knob that spans orders of magnitude is better offered on a log scale
    const middle = spread ? Math.round(Math.sqrt(Math.max(1, knob.min) * knob.max)) : Math.round((knob.min + knob.max) / 2);
    const values: Array<[string, number]> = [["lowest", knob.min], ["middle", middle], ["highest", knob.max]];
    return {
      heading: `${info.name}: ${knob.name}? (${formatNumber(knob.min)} to ${formatNumber(knob.max)})`,
      options: [
        { key: key(0), label: "Default", detail: knob.description, ...afterSize(fight, pending.kind, pending.bits) },
        ...values.map(([name, value], i): MenuOption => ({ key: key(i + 1), label: formatNumber(value), detail: name, ...afterSize(fight, pending.kind, pending.bits, value) })),
      ],
      entry: { label: `or type the ${knob.name}`, apply: (value) => afterSize(fight, pending.kind, pending.bits, Number(value)) },
      cancellable: true,
    };
  }
  if (pending?.step === "enemy") {
    return {
      heading: "Which enemy should it watch?",
      options: ([0, 1] as const).map((enemy) => ({ key: key(enemy), label: `Enemy ${enemy + 1}`, command: deployCommand(pending.kind, pending.bits, pending.knob, enemy) })),
      cancellable: true,
    };
  }
  if (pending?.step === "remove") {
    return {
      heading: "Remove which structure? Its Space comes back.",
      options: fight.structures.map((view, i) => ({ key: key(i), label: `${view.slot + 1}. ${structures[view.kind].name}`, detail: `${formatNumber(view.spaceBits)} bits`, command: `remove ${view.slot + 1}` })),
      cancellable: true,
    };
  }

  const noRoom = fight.slotsFree === 0 ? "every slot is in use" : fight.changesLeft === 0 ? "no changes left this turn" : fight.spaceFree < 1 ? "no Space left" : undefined;
  return {
    heading: "Deploy structures, then let the stream arrive.",
    options: [
      ...run.owned.map((kind, i): MenuOption => ({ key: key(i), label: structures[kind].name, detail: structures[kind].summary, next: { step: "size", kind }, ...(noRoom ? { disabled: noRoom } : {}) })),
      ...(fight.structures.length > 0
        ? [{ key: "x", label: "Remove a structure", detail: fight.changesLeft === 0 ? "no changes left this turn" : "its Space comes back", next: { step: "remove" }, ...(fight.changesLeft === 0 ? { disabled: "no changes left this turn" } : {}) } satisfies MenuOption]
        : []),
      { key: "Enter", label: "Ready", detail: "let the stream arrive", command: "ready" },
    ],
    cancellable: false,
  };
}

function strikeMenu(fight: Observation, pending: Pending): Menu {
  const challenge = fight.challenge;
  if (!challenge) return { heading: "Waiting.", options: [], cancellable: false };
  if (challenge.kind === "presence" || challenge.kind === "likeness") {
    const picked = pending?.step === "targets" ? pending.picked : [];
    return {
      heading: challenge.kind === "presence" ? "Which of these are in the stream? Press a number to mark it." : "Which of these sets are like the stream? Press a number to mark one.",
      options: [
        ...challenge.targets.slice(0, 9).map((_, position): MenuOption => {
          const next = picked.includes(position) ? picked.filter((p) => p !== position) : [...picked, position].sort((a, b) => a - b);
          return { key: String(position + 1), label: `${position + 1}`, detail: picked.includes(position) ? "marked" : "", shown: true, next: { step: "targets", picked: next } };
        }),
        { key: "c", label: "Strike what two structures agree on", command: "strike confirmed" },
        { key: "f", label: "Strike what any structure flagged", command: "strike flagged" },
        { key: "Enter", label: picked.length > 0 ? `Strike ${picked.map((p) => p + 1).join(", ")}` : "Strike nothing", command: picked.length > 0 ? `strike ${picked.map((p) => p + 1).join(" ")}` : "strike none" },
      ],
      cancellable: picked.length > 0,
    };
  }
  const numeric = fight.structures.some((view) => view.answer && typeof view.answer.estimate === "number");
  const none = numeric ? undefined : "no structure here can answer";
  const verb = challenge.kind === "count" ? "Estimate the distinct values." : challenge.kind === "frequency" ? "How many times has the shield's value appeared?" : "Which value sits at the armor's rank?";
  return {
    heading: verb,
    options: [
      { key: "e", label: "Strike with the estimate", detail: "the structure's best guess", command: "strike estimate", ...(none ? { disabled: none } : {}) },
      { key: "h", label: "Strike with the upper bound", detail: challenge.kind === "count" ? "usually too high to hurt" : "safe: never too weak", command: "strike high", ...(none ? { disabled: none } : {}) },
      { key: "l", label: "Strike with the lower bound", detail: challenge.kind === "count" ? "usually too low to hurt" : "risky: may be blocked", command: "strike low", ...(none ? { disabled: none } : {}) },
    ],
    entry: { label: "or type a number", apply: (value) => ({ command: `strike ${value}` }) },
    cancellable: false,
  };
}

function rewardMenu(run: RunObservation): Menu {
  return {
    heading: "Choose a reward.",
    options: (run.offers ?? []).map((offer, i) => {
      if (offer.kind === "structure") return { key: key(i), label: structures[offer.structure].name, detail: `${run.owned.includes(offer.structure) ? "second copy, for a fusion that needs two" : "new structure"}: ${structures[offer.structure].summary}`, command: `choose ${i + 1}` };
      if (offer.kind === "enchantment") return { key: key(i), label: enchantments[offer.enchantment]?.name ?? offer.enchantment, detail: `enchantment: ${enchantments[offer.enchantment]?.summary ?? ""}`, command: `choose ${i + 1}` };
      return { key: key(i), label: upgrades[offer.upgrade]?.name ?? offer.upgrade, detail: `upgrade: ${upgrades[offer.upgrade]?.summary ?? ""}`, command: `choose ${i + 1}` };
    }),
    cancellable: false,
  };
}

function restMenu(run: RunObservation): Menu {
  const fuse = (run.fusions ?? []).map((fusion, i): MenuOption => ({
    key: key(i),
    label: `Fuse: ${fusions[fusion.id]?.name ?? fusion.id}`,
    detail: `${fusion.inputs.map((kind) => structures[kind].name).join(" and ")} become ${structures[fusion.result].name}`,
    command: `fuse ${fusion.id}`,
  }));
  const enchant = (run.enchantable ?? []).map((option, i): MenuOption => ({
    key: key(fuse.length + i),
    label: `Enchant ${structures[option.kind].name}`,
    detail: `${enchantments[option.enchantmentId]?.name ?? option.enchantmentId}: ${enchantments[option.enchantmentId]?.summary ?? ""}`,
    command: `enchant ${option.enchantmentId} ${alias(option.kind)}`,
  }));
  return {
    heading: fuse.length + enchant.length > 0 ? "A rest stop. Fuse or enchant, then go on." : "A rest stop. Nothing to fuse or enchant.",
    options: [...fuse, ...enchant, { key: "Enter", label: "Go on to the next fight", command: "leave" }],
    cancellable: false,
  };
}

/** The choices on offer in the current phase, and what they lead to. Empty when the run is over. */
export function playMenu(run: RunObservation, pending: Pending = null): Menu {
  if (run.phase === "won" || run.phase === "lost") return { heading: run.phase === "won" ? "The act is won." : "The act is lost.", options: [], cancellable: false };
  if (run.phase === "reward") return rewardMenu(run);
  if (run.phase === "rest") return restMenu(run);
  const fight = run.fight as Observation;
  return fight.phase === "strike" ? strikeMenu(fight, pending) : deployMenu(run, fight, pending);
}

export interface MapNode {
  index: number;
  tier: RunObservation["tier"];
  /** `done` once beaten, `current` while it is being fought, `next` for the one the run is about to enter, otherwise `ahead`. */
  state: "done" | "current" | "next" | "ahead";
}

/** The act as a row of fights, from the tier of each (all the player is told about a fight before it starts). */
export function runMap(run: RunObservation, tiers: ReadonlyArray<RunObservation["tier"]>): MapNode[] {
  const finished = run.phase === "won" ? tiers.length : run.phase === "reward" ? run.encounter + 1 : run.encounter;
  return tiers.map((tier, index): MapNode => ({
    index,
    tier,
    state: index < finished ? "done" : index === run.encounter && run.phase === "fight" ? "current" : index === finished && run.phase !== "lost" ? "next" : "ahead",
  }));
}
