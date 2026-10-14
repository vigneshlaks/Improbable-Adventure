import { describe, expect, it } from "vitest";
import narrationJson from "../narration.json";
import { EVENT_TEMPLATES, narration, parseNarration, placeholdersOf } from "./narration";

describe("placeholdersOf", () => {
  it("lists the variables in a template", () => {
    expect(placeholdersOf("{name} takes slot {slot}.")).toEqual(["name", "slot"]);
    expect(placeholdersOf("No variables here.")).toEqual([]);
  });
});

describe("narration.json", () => {
  it("has a template for every kind of event, using only variables the narrator provides", () => {
    for (const [key, allowed] of Object.entries(EVENT_TEMPLATES)) {
      const template = narration.events[key as keyof typeof EVENT_TEMPLATES];
      expect(template.length, key).toBeGreaterThan(0);
      for (const variable of placeholdersOf(template)) expect(allowed as readonly string[], `${key} uses {${variable}}`).toContain(variable);
    }
  });

  it("describes every trait at every level, every tier, and every command", () => {
    for (const trait of ["variety", "skew", "churn", "growth", "drift"] as const) {
      for (const level of ["low", "medium", "high"] as const) expect(narration.enemy.traits[trait][level].length).toBeGreaterThan(0);
    }
    for (const tier of ["minion", "elite", "boss"] as const) expect(narration.enemy.intro[tier].length).toBeGreaterThan(0);
    for (const command of ["deploy", "remove", "ready", "query", "strike", "status", "help", "quit"] as const) {
      expect(narration.commands[command].usage.startsWith(command)).toBe(true);
      expect(narration.commands[command].summary.length).toBeGreaterThan(5);
    }
  });

  it("has the lines the terminal game opens and closes with", () => {
    expect(narration.game.welcome).toMatch(/help/);
    expect(narration.game.goodbye.length).toBeGreaterThan(0);
  });

  it("rejects a template that uses an unknown variable", () => {
    const bad = { ...narrationJson, events: { ...narrationJson.events, structureDeployed: "{name} takes slot {slott}." } };
    expect(() => parseNarration(bad)).toThrow();
  });

  it("rejects a missing event template, a missing trait level and an extra key", () => {
    const { enemyAttacked: _removed, ...rest } = narrationJson.events;
    void _removed;
    expect(() => parseNarration({ ...narrationJson, events: rest })).toThrow();
    const { low: _low, ...variety } = narrationJson.enemy.traits.variety;
    void _low;
    expect(() => parseNarration({ ...narrationJson, enemy: { ...narrationJson.enemy, traits: { ...narrationJson.enemy.traits, variety } } })).toThrow();
    expect(() => parseNarration({ ...narrationJson, extra: 1 })).toThrow();
  });
});
