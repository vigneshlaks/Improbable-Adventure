import { enchantments, narration, structures, upgrades } from "@pda/content";
import type { Observation, RunObservation, StructureView } from "@pda/engine";
import { formatNumber, playMenu, runMap, structureLabel, TRAIT_NAMES, title, type Menu, type MenuOption, type Pending, type RunSession, type StructureVisual } from "@pda/ui-core";
import { draw, element } from "./panel";

const TIER_MARK = { minion: "●", elite: "◆", boss: "★" } as const;
const KEY_LABEL: Record<string, string> = { Enter: "↵" };

export interface Play {
  /** Starts the screen over for a new session. */
  attach(session: RunSession): void;
  /** Redraws from the session's current state. */
  render(): void;
  /** Handles a key press; true when the screen used it. */
  press(event: KeyboardEvent): boolean;
  toggleOverview(force?: boolean): void;
  toggleHelp(force?: boolean): void;
}

const percent = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

function bar(className: string, share: number, label: string): HTMLElement {
  const outer = element("div", `bar ${className}`);
  const fill = element("div", "fill");
  fill.style.width = percent(share);
  outer.append(fill, element("span", "bar-label", label));
  outer.setAttribute("role", "img");
  outer.setAttribute("aria-label", label);
  return outer;
}

/** What a structure says about the open challenge, in a short line. */
function answerLine(view: StructureView): string {
  const answer = view.answer;
  if (!answer) return "cannot answer this";
  if (Array.isArray(answer.estimate)) return `flags ${answer.estimate.length}`;
  const range = answer.high === Infinity ? `at least ${formatNumber(answer.low)}` : `${formatNumber(answer.low)} to ${formatNumber(answer.high)}`;
  return `about ${formatNumber(answer.estimate)} (${range})`;
}

/**
 * The game as a picture: the act as a row of fights, the enemy and its stream on one side, the player's structures on the other,
 * and the keys that can be pressed now. It runs the same session as the text screen, by turning each key into the command the
 * terminal would take, so the rules and the narration are the same in both.
 */
export function createPlay(parts: { root: HTMLElement; onChange(session: RunSession, over: boolean): void }): Play {
  const { root } = parts;
  let session: RunSession | null = null;
  let pending: Pending = null;
  let over = false;
  let notes: string[] = [];
  let overview = false;
  let help = false;
  let lastHp: { encounter: number; hp: number; certainty: number } | null = null;
  const maxHp = new Map<number, number>();

  function menuNow(): Menu {
    return playMenu((session as RunSession).observe(), pending);
  }

  function run(command: string) {
    if (!session || over) return;
    const reply = session.handle(command);
    notes = reply.story ?? reply.lines;
    over = reply.done;
    pending = null;
    render();
  }

  function choose(option: MenuOption) {
    if (option.disabled) {
      notes = [`Not now: ${option.disabled}.`];
      render();
    } else if (option.next !== undefined) {
      pending = option.next;
      notes = [];
      render();
    } else if (option.command !== undefined) run(option.command);
  }

  // ---- the act as a row of fights, with the run's resources ----
  function strip(observed: RunObservation, current: Observation | null): HTMLElement {
    const top = element("section", "strip");
    top.setAttribute("aria-label", "The act");
    const nodes = element("ol", "nodes");
    for (const node of runMap(observed, (session as RunSession).tiers())) {
      const item = element("li", `node ${node.state} ${node.tier}`, TIER_MARK[node.tier]);
      item.title = `Fight ${node.index + 1}: ${node.tier}${node.state === "done" ? " (beaten)" : node.state === "current" ? " (now)" : ""}`;
      item.setAttribute("aria-label", item.title);
      nodes.append(item);
    }
    const certainty = bar("certainty", observed.certainty / Math.max(1, observed.maxCertainty), `Certainty ${formatNumber(observed.certainty)} of ${formatNumber(observed.maxCertainty)}`);
    if (lastHp && current && lastHp.encounter === observed.encounter && observed.certainty < lastHp.certainty) certainty.classList.add("hurt");
    const open = element("button", "plain", overview ? "Close overview (O)" : "Overview (O)");
    open.type = "button";
    open.addEventListener("click", () => toggleOverview());
    top.append(nodes, certainty, open);
    return top;
  }

  // ---- the enemy ----
  function enemyCard(observed: RunObservation, fight: Observation): HTMLElement {
    const card = element("section", `enemy ${observed.tier}`);
    card.setAttribute("aria-label", "The enemy");
    const max = maxHp.get(observed.encounter) ?? fight.enemyHp;
    const hp = bar("hp", fight.enemyHp / Math.max(1e-9, max), `Enemy HP ${formatNumber(fight.enemyHp)}`);
    if (lastHp && lastHp.encounter === observed.encounter && fight.enemyHp < lastHp.hp) hp.classList.add("hit");
    card.append(element("div", "sprite", TIER_MARK[observed.tier]), element("h2", "", `${title(observed.tier)}, fight ${observed.encounter + 1} of ${observed.encounters}`), hp);
    const traits = element("ul", "traits");
    for (const trait of TRAIT_NAMES) {
      const level = fight.traits[trait];
      if (level === "low") continue;
      const chip = element("li", `trait ${level}`, `${title(trait)} ${level}`);
      chip.title = (narration.enemy.traits as Record<string, Record<string, string>>)[trait]?.[level] ?? "";
      traits.append(chip);
    }
    if (fight.secondTraits) traits.append(element("li", "trait high", "Two enemies"));
    if (traits.childElementCount === 0) traits.append(element("li", "trait", "A plain, steady stream"));
    card.append(traits, element("p", "weak", fight.weakPoint ? `Weak point: ${fight.weakPoint}` : "Weak point: not yet known"));
    card.append(element("p", "turn", `Turn ${fight.turn}`));
    return card;
  }

  // ---- the stream and the question it asks ----
  function lane(fight: Observation): HTMLElement {
    const box = element("section", `lane ${fight.phase}`);
    box.setAttribute("aria-label", "The stream");
    const flow = element("div", "flow");
    flow.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 12; i++) {
      const dot = element("span", "dot");
      dot.style.setProperty("--i", String(i));
      flow.append(dot);
    }
    box.append(flow);
    const challenge = fight.challenge;
    if (fight.phase !== "strike" || !challenge) {
      box.append(element("p", "ask", fight.structures.length === 0 ? "Deploy structures to catch the stream." : "Ready when you are."));
      return box;
    }
    const picked = pending?.step === "targets" ? pending.picked : [];
    if (challenge.kind === "presence" || challenge.kind === "likeness") {
      box.append(element("p", "ask", challenge.kind === "presence" ? "Which of these values are in the stream?" : `Which sets are alike the stream (at least ${formatNumber(challenge.threshold * 100)}% shared)?`));
      const tokens = element("ol", "targets");
      challenge.targets.forEach((target, position) => {
        const flaggedBy = fight.structures.filter((view) => Array.isArray(view.answer?.estimate) && (view.answer?.estimate as number[]).includes(target)).map((view) => view.slot + 1);
        const token = element("li", `target${picked.includes(position) ? " marked" : ""}${flaggedBy.length >= 2 ? " confirmed" : flaggedBy.length === 1 ? " flagged" : ""}`);
        token.append(element("span", "tn", String(position + 1)), element("span", "tv", challenge.kind === "presence" ? String(target) : `${challenge.copies[position]?.length ?? 0} values`));
        if (flaggedBy.length > 0) token.append(element("span", "tf", `slot${flaggedBy.length > 1 ? "s" : ""} ${flaggedBy.join(", ")}`));
        token.addEventListener("click", () => {
          const next = picked.includes(position) ? picked.filter((p) => p !== position) : [...picked, position].sort((a, b) => a - b);
          pending = { step: "targets", picked: next };
          render();
        });
        tokens.append(token);
      });
      box.append(tokens);
    } else if (challenge.kind === "frequency") {
      box.append(element("p", "ask", "A shield guards the value"), element("p", "big", String(challenge.value)), element("p", "ask", "How many times has it appeared?"));
    } else if (challenge.kind === "rank") {
      box.append(element("p", "ask", `Armor at rank ${formatNumber(challenge.quantile * 100)}%`), bar("armor", challenge.quantile, `${formatNumber(challenge.quantile * 100)}% of values sit at or below`), element("p", "ask", "Which value sits there? Too low is blocked; far too high wastes the blow."));
    } else box.append(element("p", "ask", "How many different values are in the stream right now?"));
    return box;
  }

  // ---- the player's structures ----
  function slots(fight: Observation, visuals: StructureVisual[]): HTMLElement {
    const column = element("section", "slots");
    column.setAttribute("aria-label", "Your structures");
    const total = fight.structures.length + fight.slotsFree;
    for (let slot = 0; slot < total; slot++) {
      const view = fight.structures.find((candidate) => candidate.slot === slot);
      const card = element("article", `slot${view ? "" : " empty"}`);
      if (!view) {
        card.append(element("span", "slot-n", String(slot + 1)), element("span", "muted", "empty slot"));
      } else {
        const visual = visuals.find((candidate) => candidate.slot === slot);
        card.append(element("h3", "", `${slot + 1}. ${structureLabel(view.kind, view.enchantment)}`));
        if (view.source !== undefined) card.append(element("span", "watch", view.merged ? "both enemies" : `watches enemy ${view.source + 1}`));
        if (visual) card.append(draw(visual));
        card.append(element("p", "space", `${formatNumber(view.spaceBits)} bits`));
        if (fight.phase === "strike") card.append(element("p", "says", answerLine(view)));
        else if (visual) card.append(element("p", "says", visual.readout));
      }
      column.append(card);
    }
    column.append(bar("space", fight.spaceFree / Math.max(1, fight.spaceFree + fight.structures.reduce((sum, view) => sum + view.spaceBits, 0)), `Space free: ${formatNumber(fight.spaceFree)} bits`));
    return column;
  }

  // ---- screens between fights ----
  function between(observed: RunObservation): HTMLElement {
    const box = element("section", "between");
    box.append(element("h2", "", observed.phase === "reward" ? "Fight won. Choose a reward." : observed.phase === "rest" ? "A rest stop." : observed.phase === "won" ? "The act is won." : "The act is lost."));
    if (observed.phase === "rest") box.append(element("p", "muted", "You recover some Certainty. Fuse structures or attach enchantments, then go on."));
    return box;
  }

  // ---- what to press ----
  function actions(menu: Menu, detailed: boolean): HTMLElement {
    const bay = element("section", "actions");
    bay.setAttribute("aria-label", "Actions");
    bay.append(element("h2", "", menu.heading));
    const list = element("div", `keys${detailed ? " detailed" : ""}`);
    for (const option of menu.options.filter((candidate) => !candidate.shown)) {
      const button = element("button", `key${option.disabled ? " off" : ""}${option.detail === "marked" ? " on" : ""}`);
      button.type = "button";
      const text = element("span", "text");
      text.append(element("span", "label", option.label));
      if (detailed && option.detail) text.append(element("span", "detail", option.detail));
      button.append(element("kbd", "", KEY_LABEL[option.key] ?? option.key.toUpperCase()), text);
      if (option.detail || option.disabled) button.title = option.disabled ? `Not now: ${option.disabled}` : (option.detail as string);
      button.setAttribute("aria-disabled", String(Boolean(option.disabled)));
      button.addEventListener("click", () => choose(option));
      list.append(button);
    }
    if (menu.cancellable) {
      const back = element("button", "key");
      back.type = "button";
      back.append(element("kbd", "", "Esc"), element("span", "label", "Back"));
      back.addEventListener("click", () => {
        pending = null;
        render();
      });
      list.append(back);
    }
    bay.append(list);
    const hint = element("p", "hint");
    if (!detailed) bay.append(hint);
    list.addEventListener("mouseover", (event) => {
      const target = (event.target as HTMLElement).closest("button");
      hint.textContent = target?.title ?? "";
    });
    if (menu.entry) {
      const entry = menu.entry;
      const form = element("form", "entry");
      const input = element("input", "");
      input.inputMode = "numeric";
      input.placeholder = entry.label;
      input.setAttribute("aria-label", entry.label);
      input.autocomplete = "off";
      form.append(input, element("kbd", "", "/"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (value === "") return;
        const result = entry.apply(value);
        if (result.next !== undefined) {
          pending = result.next;
          notes = [];
          render();
        } else if (result.command !== undefined) run(result.command);
      });
      bay.append(form);
    }
    return bay;
  }

  function messages(): HTMLElement {
    const box = element("section", `messages${notes.length > 0 ? "" : " quiet"}`);
    box.setAttribute("role", "status");
    box.append(...notes.filter((line) => line.trim() !== "").slice(-8).map((line) => element("p", "", line)));
    return box;
  }

  function overviewPanel(observed: RunObservation): HTMLElement {
    const drawer = element("aside", "overview");
    const close = element("button", "plain", "Close (Esc)");
    close.type = "button";
    close.addEventListener("click", () => toggleOverview(false));
    drawer.append(close, element("h2", "", "Your run"));
    const list = (heading: string, items: string[]) => {
      drawer.append(element("h3", "", heading));
      drawer.append(items.length === 0 ? element("p", "muted", "none") : (() => {
        const ul = element("ul", "");
        for (const item of items) ul.append(element("li", "", item));
        return ul;
      })());
    };
    list("Structures", observed.owned.map((kind) => `${structureLabel(kind, observed.attached[kind])}: ${structures[kind].summary}`));
    list("Upgrades", Object.entries(observed.upgrades).filter(([, n]) => n > 0).map(([id, n]) => `${upgrades[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}: ${upgrades[id]?.summary ?? ""}`));
    list("Enchantments in the pack", observed.enchantments.map((id) => `${enchantments[id]?.name ?? id}: ${enchantments[id]?.summary ?? ""}`));
    drawer.append(element("h3", "", "The act"));
    const fights = element("ol", "fights");
    for (const node of runMap(observed, (session as RunSession).tiers())) fights.append(element("li", node.state, `${TIER_MARK[node.tier]} Fight ${node.index + 1}, ${node.tier}${node.state === "done" ? ", beaten" : node.state === "current" ? ", now" : ""}`));
    drawer.append(fights);
    return drawer;
  }

  function helpPanel(): HTMLElement {
    const box = element("aside", "overview helpbox");
    const close = element("button", "plain", "Close (Esc)");
    close.type = "button";
    close.addEventListener("click", () => toggleHelp(false));
    box.append(close, element("h2", "", "Keys"));
    const rows: Array<[string, string]> = [
      ["1–9, A–Z", "choose from the list on the action bar"],
      ["Enter", "ready, strike, or go on"],
      ["X", "remove a structure"],
      ["Esc", "go back one step"],
      ["/", "type a number (a Space size or a strike force)"],
      ["O", "the run overview"],
      ["T", "switch to the text screen, where every command works"],
      ["?", "this help"],
    ];
    const dl = element("dl", "");
    for (const [k, v] of rows) dl.append(element("dt", "", k), element("dd", "", v));
    box.append(dl, element("p", "muted", "Hover a choice to read what it does."));
    return box;
  }

  function render() {
    if (!session) return;
    const observed = session.observe();
    const fight = observed.fight;
    if (fight && fight.turn === 1 && fight.phase === "deploy" && !maxHp.has(observed.encounter)) maxHp.set(observed.encounter, fight.enemyHp);
    const children: HTMLElement[] = [strip(observed, fight)];
    if (fight && observed.phase === "fight") {
      const stage = element("div", "stage");
      stage.append(enemyCard(observed, fight), lane(fight), slots(fight, session.structures()));
      children.push(stage);
    } else children.push(between(observed));
    children.push(messages());
    if (!over) children.push(actions(menuNow(), observed.phase === "reward" || observed.phase === "rest"));
    else children.push(element("section", "actions", ""));
    if (overview) children.push(overviewPanel(observed));
    if (help) children.push(helpPanel());
    root.replaceChildren(...children);
    lastHp = fight ? { encounter: observed.encounter, hp: fight.enemyHp, certainty: observed.certainty } : null;
    parts.onChange(session, over);
  }

  function toggleOverview(force?: boolean) {
    overview = force ?? !overview;
    if (overview) help = false;
    render();
  }
  function toggleHelp(force?: boolean) {
    help = force ?? !help;
    if (help) overview = false;
    render();
  }

  function press(event: KeyboardEvent): boolean {
    if (!session || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (typing) {
      if (event.key === "Escape") (target as HTMLElement).blur();
      return false;
    }
    const key = event.key;
    if (key === "?") return toggleHelp(), true;
    if (key === "o" || key === "O") return toggleOverview(), true;
    if (key === "/") {
      const input = root.querySelector<HTMLInputElement>(".entry input");
      if (!input) return false;
      input.focus();
      return true;
    }
    if (key === "Escape") {
      if (help || overview) return help ? toggleHelp(false) : toggleOverview(false), true;
      if (pending !== null && menuNow().cancellable) return (pending = null), render(), true;
      return false;
    }
    if (over) return false;
    const wanted = key === " " ? "Enter" : key.length === 1 ? key.toLowerCase() : key;
    const option = menuNow().options.find((candidate) => candidate.key.toLowerCase() === wanted.toLowerCase());
    if (!option) return false;
    choose(option);
    return true;
  }

  return {
    attach(next) {
      session = next;
      pending = null;
      over = false;
      overview = false;
      help = false;
      lastHp = null;
      maxHp.clear();
      notes = next.opening().filter((line) => line.startsWith("A ") || line.startsWith("An ")).slice(0, 1);
      render();
    },
    render,
    press,
    toggleOverview,
    toggleHelp,
  };
}
