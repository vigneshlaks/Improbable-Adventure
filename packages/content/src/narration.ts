import { z } from "zod";
import narrationJson from "../narration.json";

/**
 * The variables the narrator supplies to each event template. A template may use any of these, written as
 * `{name}`. Loading fails if a template names a variable that is not listed here.
 */
export const EVENT_TEMPLATES = {
  structureDeployed: ["name", "slot", "bits"],
  structureRemoved: ["name", "slot", "bits"],
  burstIngested: ["turn", "events", "inserts", "deletes"],
  burstIngestedWithDeletes: ["turn", "events", "inserts", "deletes"],
  challengePresence: ["count"],
  challengeFrequency: ["value"],
  challengeCount: [],
  weakPointRevealed: ["weakPoint"],
  strikeFrequencyHit: ["damage", "trueCount", "force"],
  strikeFrequencyBlocked: ["certaintyLost", "trueCount", "force"],
  strikeCountHit: ["damage", "trueDistinct", "estimate"],
  strikeCountMiss: ["certaintyLost", "trueDistinct", "estimate"],
  strikePresence: ["realHits", "decoyHits", "damage", "certaintyLost", "realTotal"],
  enemyAttacked: ["damage"],
  turnStarted: ["turn"],
  fightWon: ["turn"],
  fightLostTurnLimit: ["certaintyLost"],
  fightLostCertainty: [],
} as const;

export type EventTemplateKey = keyof typeof EVENT_TEMPLATES;

/** The variable names used in a template, in order. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
}

const template = (key: EventTemplateKey) =>
  z
    .string()
    .min(1)
    .refine((text) => placeholdersOf(text).every((name) => (EVENT_TEMPLATES[key] as readonly string[]).includes(name)), {
      message: `uses a variable that is not provided for ${key}`,
    });

const perLevel = z.object({ low: z.string().min(1), medium: z.string().min(1), high: z.string().min(1) }).strict();
const command = z.object({ usage: z.string().min(1), summary: z.string().min(1) }).strict();

const eventsSchema = z
  .object(
    Object.fromEntries((Object.keys(EVENT_TEMPLATES) as EventTemplateKey[]).map((key) => [key, template(key)])) as Record<
      EventTemplateKey,
      ReturnType<typeof template>
    >,
  )
  .strict();

export const narrationSchema = z
  .object({
    events: eventsSchema,
    enemy: z
      .object({
        intro: z.object({ minion: z.string().min(1), elite: z.string().min(1), boss: z.string().min(1) }).strict(),
        calm: z.string().min(1),
        traits: z
          .object({ variety: perLevel, skew: perLevel, churn: perLevel, growth: perLevel, drift: perLevel })
          .strict(),
      })
      .strict(),
    commands: z
      .object({
        deploy: command,
        remove: command,
        ready: command,
        query: command,
        strike: command,
        status: command,
        help: command,
        quit: command,
      })
      .strict(),
    game: z.object({ welcome: z.string().min(1), goodbye: z.string().min(1) }).strict(),
  })
  .strict();

export type Narration = z.infer<typeof narrationSchema>;

export function parseNarration(raw: unknown): Narration {
  return narrationSchema.parse(raw);
}

/** Story text and command help, as validated at load time. Throws if narration.json is malformed. */
export const narration: Narration = parseNarration(narrationJson);
