import { IllegalActionError, type FightConfig, type GameEvent } from "../combat/types";
import { createFight, step as stepFight } from "../combat/fight";
import { legalActions as fightActions, observe as observeFight } from "../combat/view";
import { Rng } from "../rng/rng";
import type { StructureKind } from "../structures/types";
import type { FusionDef, RewardDef, RewardView, RunAction, RunConfig, RunEvent, RunObservation, RunState, RunStepResult, UpgradeEffect } from "./types";

/** The numbers upgrades add up to. */
interface RunStats {
  space: number;
  slots: number;
  maxCertainty: number;
  recovery: number;
  damagePercent: number;
}

function statsOf(config: RunConfig, upgrades: Record<string, number>): RunStats {
  const total: RunStats = { space: 0, slots: 0, maxCertainty: 0, recovery: 0, damagePercent: 0 };
  for (const id of Object.keys(upgrades).sort()) {
    const effect = config.upgrades[id] as UpgradeEffect;
    const times = upgrades[id] as number;
    total.space += (effect.space ?? 0) * times;
    total.slots += (effect.slots ?? 0) * times;
    total.maxCertainty += (effect.maxCertainty ?? 0) * times;
    total.recovery += (effect.recovery ?? 0) * times;
    total.damagePercent += (effect.damagePercent ?? 0) * times;
  }
  return total;
}

function validate(config: RunConfig): void {
  const need = (ok: boolean, message: string) => {
    if (!ok) throw new RangeError(`Bad run config: ${message}`);
  };
  need(config.encounters.length >= 1, "a run needs at least one encounter");
  need(Number.isInteger(config.rewardChoices) && config.rewardChoices >= 1, "rewardChoices must be a whole number >= 1");
  need(config.restHeal >= 0, "restHeal cannot be negative");
  need(Number.isInteger(config.restEnchantLimit) && config.restEnchantLimit >= 0, "restEnchantLimit must be a whole number >= 0");
  for (const index of config.restBefore) {
    need(Number.isInteger(index) && index >= 1 && index < config.encounters.length, `a rest stop cannot come before encounter ${index}`);
  }
  const recipes = new Set<string>();
  for (const fusion of config.fusions) {
    need(!recipes.has(fusion.id), `fusion id ${fusion.id} is used twice`);
    recipes.add(fusion.id);
    need(fusion.inputs.length >= 2, `fusion ${fusion.id} needs at least two inputs`);
    need(new Set(fusion.inputs).size === fusion.inputs.length, `fusion ${fusion.id} lists an input twice`);
    need(!fusion.inputs.includes(fusion.result), `fusion ${fusion.id} would produce one of its own inputs`);
  }
  const enchantmentIds = new Set<string>();
  for (const enchantment of config.enchantments) {
    need(!enchantmentIds.has(enchantment.id), `enchantment id ${enchantment.id} is used twice`);
    enchantmentIds.add(enchantment.id);
    need(enchantment.valid.length >= 1, `enchantment ${enchantment.id} fits no structure`);
  }
  const ids = new Set<string>();
  for (const reward of config.rewards) {
    need(!ids.has(reward.id), `reward id ${reward.id} is used twice`);
    ids.add(reward.id);
    need(reward.weight >= 0, `reward ${reward.id} has a negative weight`);
    if (reward.kind === "upgrade") need(reward.upgrade in config.upgrades, `reward ${reward.id} names the unknown upgrade ${reward.upgrade}`);
    if (reward.kind === "enchantment") need(enchantmentIds.has(reward.enchantment), `reward ${reward.id} names the unknown enchantment ${reward.enchantment}`);
  }
}

function startFight(state: RunState, encounter: number): { state: RunState; events: RunEvent[] } {
  const { config } = state;
  const stats = statsOf(config, state.upgrades);
  const fightConfig: FightConfig = {
    constants: config.constants,
    rules: {
      ...config.rules,
      startingSpace: config.rules.startingSpace + stats.space,
      startingSlots: config.rules.startingSlots + stats.slots,
      startingCertainty: state.certainty,
      damageMultiplier: 1 + stats.damagePercent / 100,
    },
    loadout: [...state.owned],
    enchantments: { ...state.attached },
    enemy: config.encounters[encounter] as FightConfig["enemy"],
    traitTables: config.traitTables,
  };
  const fight = createFight(`${state.seed}/fight/${encounter}`, fightConfig);
  return {
    state: { ...state, phase: "fight", encounter, fight, offers: null },
    events: [{ type: "fightStarted", encounter, encounters: config.encounters.length, tier: fightConfig.enemy.tier }],
  };
}

/** Starts a run on its first encounter. */
export function createRun(seed: string, config: RunConfig): RunState {
  validate(config);
  const base: RunState = {
    config,
    seed,
    phase: "fight",
    encounter: 0,
    fight: null,
    certainty: config.rules.startingCertainty,
    maxCertainty: config.rules.startingCertainty,
    owned: [...config.loadout],
    consumed: [],
    enchantments: [],
    attached: {},
    upgrades: {},
    offers: null,
    rewardRng: Rng.fromSeed(`${seed}/rewards`).getState(),
    turnsDone: 0,
    restEnchants: 0,
  };
  return startFight(base, 0).state;
}

/** Draws up to `count` distinct eligible rewards, each in proportion to its weight. */
function drawOffers(state: RunState): { offers: string[]; rng: RunState["rewardRng"] } {
  const rng = Rng.fromState(state.rewardRng);
  const eligible = state.config.rewards.filter(
    (reward) =>
      reward.weight > 0 && !(reward.kind === "structure" && (state.owned.includes(reward.structure) || state.consumed.includes(reward.structure))),
  );
  const offers: string[] = [];
  while (offers.length < state.config.rewardChoices && eligible.length > 0) {
    const total = eligible.reduce((sum, reward) => sum + reward.weight, 0);
    let roll = rng.float() * total;
    let index = eligible.findIndex((reward) => (roll -= reward.weight) < 0);
    if (index < 0) index = eligible.length - 1; // guards against rounding at the very end
    offers.push((eligible.splice(index, 1)[0] as RewardDef).id);
  }
  return { offers, rng: rng.getState() };
}

/** After a reward (or when none is offered): a rest stop if one is due, otherwise the next fight. */
function advance(state: RunState): { state: RunState; events: RunEvent[] } {
  const next = state.encounter + 1;
  if (state.config.restBefore.includes(next)) {
    const certainty = Math.min(state.maxCertainty, state.certainty + state.config.restHeal);
    return {
      state: { ...state, phase: "rest", encounter: next, fight: null, offers: null, certainty, restEnchants: 0 },
      events: [{ type: "restStarted", healed: certainty - state.certainty }],
    };
  }
  return startFight({ ...state, fight: null }, next);
}

/** Called when the fight in progress has just been won. */
function fightWon(state: RunState, events: Array<GameEvent | RunEvent>): RunState {
  const fight = state.fight as NonNullable<RunState["fight"]>;
  const stats = statsOf(state.config, state.upgrades);
  const certainty = Math.min(state.maxCertainty, fight.certainty + stats.recovery);
  const finished: RunState = { ...state, certainty, turnsDone: state.turnsDone + fight.turn };

  if (state.encounter === state.config.encounters.length - 1) {
    events.push({ type: "runWon", turns: finished.turnsDone, certaintyLeft: certainty });
    return { ...finished, phase: "won", fight: null, offers: null };
  }

  const { offers, rng } = drawOffers(finished);
  if (offers.length === 0) {
    const moved = advance({ ...finished, rewardRng: rng });
    events.push(...moved.events);
    return moved.state;
  }
  events.push({ type: "rewardOffered", options: offers });
  return { ...finished, phase: "reward", fight: null, offers, rewardRng: rng };
}

function chooseReward(state: RunState, index: number, events: Array<GameEvent | RunEvent>): RunState {
  const offers = state.offers as string[];
  if (!Number.isInteger(index) || index < 0 || index >= offers.length) throw new IllegalActionError(`There is no reward ${index}`);
  const id = offers[index] as string;
  const reward = state.config.rewards.find((candidate) => candidate.id === id) as RewardDef;
  events.push({ type: "rewardChosen", id });

  let chosen: RunState;
  if (reward.kind === "structure") {
    chosen = { ...state, owned: [...state.owned, reward.structure as StructureKind] };
  } else if (reward.kind === "enchantment") {
    chosen = { ...state, enchantments: [...state.enchantments, reward.enchantment] };
  } else {
    const effect = state.config.upgrades[reward.upgrade] as UpgradeEffect;
    const extra = effect.maxCertainty ?? 0;
    chosen = {
      ...state,
      upgrades: { ...state.upgrades, [reward.upgrade]: (state.upgrades[reward.upgrade] ?? 0) + 1 },
      maxCertainty: state.maxCertainty + extra,
      certainty: state.certainty + extra,
    };
  }
  const moved = advance(chosen);
  events.push(...moved.events);
  return moved.state;
}

/** The fusions whose inputs are all owned, and whose result is not already owned. */
function availableFusions(state: RunState): FusionDef[] {
  return state.config.fusions.filter(
    (fusion) => fusion.inputs.every((input) => state.owned.includes(input)) && !state.owned.includes(fusion.result),
  );
}

function fuse(state: RunState, recipeId: string, events: Array<GameEvent | RunEvent>): RunState {
  const recipe = availableFusions(state).find((fusion) => fusion.id === recipeId);
  if (!recipe) throw new IllegalActionError(`The fusion "${recipeId}" is not available`);
  events.push({ type: "fused", recipeId, inputs: [...recipe.inputs], result: recipe.result });
  // An input's enchantment is not lost with it: it goes back to the inventory, and the result starts without one.
  const attached = { ...state.attached };
  const returned: string[] = [];
  for (const input of recipe.inputs) {
    const enchantment = attached[input];
    if (enchantment !== undefined) returned.push(enchantment);
    delete attached[input];
  }
  return {
    ...state,
    owned: [...state.owned.filter((kind) => !recipe.inputs.includes(kind)), recipe.result],
    consumed: [...state.consumed, ...recipe.inputs],
    enchantments: [...state.enchantments, ...returned],
    attached,
  };
}

/** Every enchantment id the player holds, whether in the inventory or attached, each once. */
function heldEnchantments(state: RunState): string[] {
  return [...new Set([...state.enchantments, ...(Object.values(state.attached) as string[])])].sort();
}

/** The attachments that can be made now: a held enchantment onto an owned structure it fits and does not already sit on. */
function availableEnchantments(state: RunState): Array<{ enchantmentId: string; kind: StructureKind }> {
  const options: Array<{ enchantmentId: string; kind: StructureKind }> = [];
  if (state.restEnchants >= state.config.restEnchantLimit) return options; // the rest stop's changes are used up
  for (const enchantmentId of heldEnchantments(state)) {
    const def = state.config.enchantments.find((candidate) => candidate.id === enchantmentId);
    if (!def) continue;
    for (const kind of state.owned) {
      if (def.valid.includes(kind) && state.attached[kind] !== enchantmentId) options.push({ enchantmentId, kind });
    }
  }
  return options;
}

function enchant(state: RunState, enchantmentId: string, kind: StructureKind, events: Array<GameEvent | RunEvent>): RunState {
  if (state.restEnchants >= state.config.restEnchantLimit) throw new IllegalActionError("No more enchanting at this rest stop: leave it");
  const allowed = availableEnchantments(state).some((option) => option.enchantmentId === enchantmentId && option.kind === kind);
  if (!allowed) throw new IllegalActionError(`${enchantmentId} cannot be attached to ${kind} now`);

  const attached = { ...state.attached };
  const inventory = [...state.enchantments];
  // Take it from the inventory if it is there, otherwise move it off the structure that holds it.
  const spare = inventory.indexOf(enchantmentId);
  if (spare >= 0) inventory.splice(spare, 1);
  else {
    const holder = (Object.keys(attached) as StructureKind[]).find((candidate) => attached[candidate] === enchantmentId) as StructureKind;
    delete attached[holder];
  }
  // A structure holds one enchantment at a time, so the one it had goes back to the inventory.
  const replaced = attached[kind] ?? null;
  if (replaced !== null) inventory.push(replaced);
  attached[kind] = enchantmentId;
  events.push({ type: "enchanted", enchantmentId, kind, replaced });
  return { ...state, enchantments: inventory, attached, restEnchants: state.restEnchants + 1 };
}

/** Applies one action and returns the new state plus what happened. The input state is not modified. */
export function step(state: RunState, action: RunAction): RunStepResult {
  const events: Array<GameEvent | RunEvent> = [];
  let reward = 0;
  let next: RunState;

  switch (state.phase) {
    case "won":
    case "lost":
      throw new IllegalActionError("The run is over");

    case "fight": {
      if (action.type === "chooseReward" || action.type === "leaveRest" || action.type === "fuse" || action.type === "enchant") throw new IllegalActionError(`${action.type} is not allowed during a fight`);
      const result = stepFight(state.fight as NonNullable<RunState["fight"]>, action);
      events.push(...result.events);
      reward = result.reward;
      next = { ...state, fight: result.state, certainty: result.state.certainty };
      if (result.state.phase === "won") next = fightWon(next, events);
      else if (result.state.phase === "lost") {
        events.push({ type: "runLost", encounter: state.encounter });
        next = { ...next, phase: "lost", offers: null, certainty: 0, turnsDone: state.turnsDone + result.state.turn };
      }
      break;
    }

    case "reward":
      if (action.type !== "chooseReward") throw new IllegalActionError("Choose a reward");
      next = chooseReward(state, action.index, events);
      break;

    case "rest": {
      if (action.type === "fuse") {
        next = fuse(state, action.recipeId, events);
        break;
      }
      if (action.type === "enchant") {
        next = enchant(state, action.enchantmentId, action.kind, events);
        break;
      }
      if (action.type !== "leaveRest") throw new IllegalActionError("The rest stop ends with leaveRest");
      const started = startFight({ ...state, restEnchants: 0 }, state.encounter);
      events.push(...started.events);
      next = started.state;
      break;
    }
  }
  return { state: next, events, reward, done: next.phase === "won" || next.phase === "lost" };
}

/** The actions a player can take now. During a fight this is the fight's own representative list. */
export function legalActions(state: RunState): RunAction[] {
  switch (state.phase) {
    case "won":
    case "lost":
      return [];
    case "fight":
      return fightActions(state.fight as NonNullable<RunState["fight"]>);
    case "reward":
      return (state.offers ?? []).map((_, index) => ({ type: "chooseReward", index }));
    case "rest":
      return [
        ...availableFusions(state).map((fusion): RunAction => ({ type: "fuse", recipeId: fusion.id })),
        ...availableEnchantments(state).map((option): RunAction => ({ type: "enchant", ...option })),
        { type: "leaveRest" },
      ];
  }
}

function viewOf(reward: RewardDef): RewardView {
  switch (reward.kind) {
    case "structure":
      return { id: reward.id, kind: "structure", structure: reward.structure };
    case "upgrade":
      return { id: reward.id, kind: "upgrade", upgrade: reward.upgrade };
    case "enchantment":
      return { id: reward.id, kind: "enchantment", enchantment: reward.enchantment };
  }
}

/** Everything the player may see of the run. */
export function observeRun(state: RunState): RunObservation {
  return {
    phase: state.phase,
    encounter: state.encounter,
    encounters: state.config.encounters.length,
    tier: (state.config.encounters[state.encounter] as FightConfig["enemy"]).tier,
    certainty: state.certainty,
    maxCertainty: state.maxCertainty,
    owned: [...state.owned],
    upgrades: { ...state.upgrades },
    fight: state.fight ? observeFight(state.fight) : null,
    offers: state.offers
      ? state.offers.map((id) => viewOf(state.config.rewards.find((reward) => reward.id === id) as RewardDef))
      : null,
    fusions: state.phase === "rest" ? availableFusions(state) : null,
    enchantments: [...state.enchantments],
    attached: { ...state.attached },
    enchantable: state.phase === "rest" ? availableEnchantments(state) : null,
  };
}

/** Turns used so far across the whole run, counting the fight in progress. */
export function turnsTaken(state: RunState): number {
  return state.turnsDone + (state.fight && state.phase === "fight" ? state.fight.turn : 0);
}

export type { StructureKind };
