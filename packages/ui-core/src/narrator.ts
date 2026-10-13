import { narration, structures, type EventTemplateKey } from "@pda/content";
import type { Challenge, EnemyConfig, GameEvent } from "@pda/engine";

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

function challengeLines(challenge: Challenge): string[] {
  switch (challenge.kind) {
    case "presence":
      return [
        say("challengePresence", { count: challenge.targets.length }),
        ...challenge.targets.map((target, position) => `  ${position + 1}) ${target}`),
      ];
    case "frequency":
      return [say("challengeFrequency", { value: challenge.value })];
    case "count":
      return [say("challengeCount")];
  }
}

/** The text for one event, as lines. Slots are shown from 1, as the player types them. */
export function narrateEvent(event: GameEvent): string[] {
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
        ...challengeLines(event.challenge),
      ];
    case "strikeResolved": {
      const damage = formatNumber(event.damage);
      const certaintyLost = formatNumber(event.certaintyLost);
      switch (event.kind) {
        case "frequency":
          return [event.outcome === "hit" ? say("strikeFrequencyHit", { damage }) : say("strikeFrequencyBlocked", { certaintyLost })];
        case "count":
          return [event.outcome === "hit" ? say("strikeCountHit", { damage }) : say("strikeCountMiss", { certaintyLost })];
        case "presence":
          return [say("strikePresence", { realHits: event.realHits, decoyHits: event.decoyHits, damage, certaintyLost })];
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

export function narrateEvents(events: readonly GameEvent[]): string[] {
  return events.flatMap(narrateEvent);
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
