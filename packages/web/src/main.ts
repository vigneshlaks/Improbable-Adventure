import { createRunSession } from "@pda/ui-core";
import { renderPanel } from "./panel";
import { createTerminal } from "./terminal";
import { initTheme } from "./theme";
import "./style.css";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A fresh seed for a run that was not asked for by name. The page, not the engine, may use real randomness. */
const freshSeed = () => Math.random().toString(36).slice(2, 8);

let seed = new URLSearchParams(location.search).get("seed") || freshSeed();
let current = createRunSession({ seed });

const ended = byId<HTMLElement>("ended");
const terminal = createTerminal({
  transcript: byId("transcript"),
  chips: byId("chips"),
  form: byId<HTMLFormElement>("entry"),
  prompt: byId("prompt"),
  input: byId<HTMLInputElement>("line"),
  onChange(session, over) {
    renderPanel(byId("panel"), session.structures());
    ended.hidden = !over || session.replay() === null;
  },
});

function start(next: string) {
  seed = next;
  current = createRunSession({ seed });
  byId("seed").textContent = `seed ${seed}`;
  const url = new URL(location.href);
  url.searchParams.set("seed", seed);
  history.replaceState(null, "", url);
  terminal.attach(current);
}

byId("new-run").addEventListener("click", () => start(freshSeed()));
byId("download").addEventListener("click", () => {
  const replay = current.replay();
  if (!replay) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" }));
  link.download = `replay-${seed}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

// On a narrow screen the structures start folded away so the text has the room; on a wide one they are always open.
const narrow = window.matchMedia("(max-width: 720px)");
const foldPanel = () => (byId<HTMLDetailsElement>("panel-box").open = !narrow.matches);
narrow.addEventListener("change", foldPanel);
foldPanel();
initTheme(byId<HTMLButtonElement>("theme"));
start(seed);
