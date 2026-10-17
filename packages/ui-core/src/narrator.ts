import { enchantments, narration, structures, upgrades, type EventTemplateKey } from "@pda/content";
import type { Challenge, EnemyConfig, GameEvent, RunEvent, StructureKind } from "@pda/engine";

/** Shows whole numbers plainly and rounds the rest to at most two decimals. */
export function formatNumber(x: number): string {
  if (x === Infinity) return "no limit";
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(2)));
}

/** Fills `{name}` placeholders. A missing variable is a bug in the template, so it throws. */
export function renderTemplate(template: string, variables: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Template variable "${name}" was not provided`);
    return String(value);
  });
}

const say = (key: EventTemplateKey, variables: Record<string, string | number> = {}) =>
  renderTemplate(narration.events[key], variables);

export interface NarrateOptions {
  /** Whether a Presence challenge lists its targets. A screen that prints them with the structures' answers turns this off. */
  listTargets?: boolean;
}

function challengeLines(challenge: Challenge, { listTargets = true }: NarrateOptions): string[] {
  switch (challenge.kind) {
    case "presence":
      return [
        say("challengePresence", { count: challenge.targets.length }),
        ...(listTargets ? challenge.targets.map((target, position) => `  ${position + 1}) ${target}`) : []),
      ];
    case "frequency":
      return [say("challengeFrequency", { value: challenge.value })];
    case "count":
      return [say("challengeCount")];
  }
}

/** The text for one event, as lines. Slots are shown from 1, as the player types them. */
export function narrateEvent(event: GameEvent, options: NarrateOptions = {}): string[] {
  switch (event.type) {
    case "structureDeployed":
      return [say("structureDeployed", { name: structures[event.kind].name, slot: event.slot + 1, bits: event.spaceBits })];
    case "structureRemoved":
      return [say("structureRemoved", { name: structures[event.kind].name, slot: event.slot + 1, bits: event.spaceBits })];
    case "burstIngested":
      return [say(event.deletes > 0 ? "burstIngestedWithDeletes" : "burstIngested", { ...event })];
    case "challengeIssued":
      return [
        ...(event.firstReveal ? [say("weakPointRevealed", { weakPoint: event.weakPoint })] : []),
        ...challengeLines(event.challenge, options),
      ];
    case "strikeResolved": {
      const damage = formatNumber(event.damage);
      const certaintyLost = formatNumber(event.certaintyLost);
      switch (event.kind) {
        case "frequency":
          return [
            event.outcome === "hit"
              ? say("strikeFrequencyHit", { damage, trueCount: event.trueCount, force: formatNumber(event.force) })
              : say("strikeFrequencyBlocked", { certaintyLost, trueCount: event.trueCount, force: formatNumber(event.force) }),
          ];
        case "count":
          return [
            event.outcome === "hit"
              ? say("strikeCountHit", { damage, trueDistinct: event.trueDistinct, estimate: formatNumber(event.estimate) })
              : say("strikeCountMiss", { certaintyLost, trueDistinct: event.trueDistinct, estimate: formatNumber(event.estimate) }),
          ];
        case "presence":
          return [say("strikePresence", { realHits: event.realHits, decoyHits: event.decoyHits, damage, certaintyLost, realTotal: event.realTotal })];
      }
      return [];
    }
    case "enemyAttacked":
      return [say("enemyAttacked", { damage: formatNumber(event.damage) })];
    case "turnStarted":
      return [say("turnStarted", { turn: event.turn })];
    case "fightWon":
      return [say("fightWon", { turn: event.turn })];
    case "fightLost":
      return [
        event.reason === "turnLimit"
          ? say("fightLostTurnLimit", { certaintyLost: formatNumber(event.certaintyLost) })
          : say("fightLostCertainty"),
      ];
  }
}

export function narrateEvents(events: readonly GameEvent[], options: NarrateOptions = {}): string[] {
  return events.flatMap((event) => narrateEvent(event, options));
}

const RUN_EVENT_TYPES = new Set(["fightStarted", "rewardOffered", "rewardChosen", "restStarted", "fused", "enchanted", "runWon", "runLost"]);

/** The player-facing name of a reward id such as "structure:logLog" or "upgrade:power". */
export function rewardName(id: string): string {
  const [kind, name] = id.split(":") as [string, string];
  if (kind === "structure") return structures[name as StructureKind]?.name ?? name;
  if (kind === "enchantment") return enchantments[name]?.name ?? name;
  return upgrades[name]?.name ?? name;
}

const structureNames = (kinds: readonly StructureKind[]) => kinds.map((kind) => structures[kind].name).join(" and ");

/** The text for one event of the run itself (a fight starting, a reward, a rest stop, the ending). */
export function narrateRunEvent(event: RunEvent): string[] {
  switch (event.type) {
    case "fightStarted":
      return [say("fightStarted", { number: event.encounter + 1, total: event.encounters })];
    case "rewardOffered":
      return [say("rewardOffered")];
    case "rewardChosen":
      return [say("rewardChosen", { name: rewardName(event.id) })];
    case "restStarted":
      return [say("restStarted", { healed: formatNumber(event.healed) })];
    case "fused":
      return [say("fused", { inputs: structureNames(event.inputs), result: structures[event.result].name })];
    case "enchanted": {
      const enchantment = enchantments[event.enchantmentId]?.name ?? event.enchantmentId;
      const structure = structures[event.kind].name;
      if (event.replaced === null) return [say("enchanted", { enchantment, structure })];
      return [say("enchantedReplacing", { enchantment, structure, replaced: enchantments[event.replaced]?.name ?? event.replaced })];
    }
    case "runWon":
      return [say("runWon", { turns: event.turns, certaintyLeft: formatNumber(event.certaintyLeft) })];
    case "runLost":
      return [say("runLost", { number: event.encounter + 1 })];
  }
}

/** Narrates the events of one step of a run: fight events as the fight narrator does, run events by their own templates. */
export function narrateRunStep(events: ReadonlyArray<GameEvent | RunEvent>, options: NarrateOptions = {}): string[] {
  return events.flatMap((event) =>
    RUN_EVENT_TYPES.has(event.type) ? narrateRunEvent(event as RunEvent) : narrateEvent(event as GameEvent, options),
  );
}

const TRAIT_NAMES = ["variety", "skew", "churn", "growth", "drift"] as const;
const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Introduces an enemy and describes each trait that is above Low. */
export function describeEnemy(enemy: Pick<EnemyConfig, "tier" | "traits">): string[] {
  const lines = TRAIT_NAMES.flatMap((trait) => {
    const level = enemy.traits[trait];
    return level === "low" ? [] : [`- ${title(trait)} (${level}): ${narration.enemy.traits[trait][level]}.`];
  });
  return [narration.enemy.intro[enemy.tier], ...(lines.length > 0 ? lines : [narration.enemy.calm])];
}

export { TRAIT_NAMES, title };
