import { structureConstants } from "@pda/content";
import { buildToolkit, sizingConstants, toolkitZip, type Language } from "@pda/exporter";
import { createRunSession } from "@pda/ui-core";
import { createPlay } from "./play";
import { renderPanel } from "./panel";
import { createTerminal } from "./terminal";
import { templatesFor } from "./templates";
import { initTheme } from "./theme";
import { parseWorkload } from "./workload";
import "./style.css";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A fresh seed for a run that was not asked for by name. The page, not the engine, may use real randomness. */
const freshSeed = () => Math.random().toString(36).slice(2, 8);

let seed = new URLSearchParams(location.search).get("seed") || freshSeed();
let current = createRunSession({ seed });

const ended = byId<HTMLElement>("ended");
const showEnded = (session: { replay(): unknown }, over: boolean) => (ended.hidden = !over || session.replay() === null);
const play = createPlay({
  root: byId("play"),
  onChange: showEnded,
});
const terminal = createTerminal({
  transcript: byId("transcript"),
  chips: byId("chips"),
  form: byId<HTMLFormElement>("entry"),
  prompt: byId("prompt"),
  input: byId<HTMLInputElement>("line"),
  onChange(session, over) {
    renderPanel(byId("panel"), session.structures());
    showEnded(session, over);
  },
});

// Two screens on one session: the picture (the default, played with keys) and the text screen, where every command works.
type Mode = "play" | "text";
let mode: Mode = new URLSearchParams(location.search).get("mode") === "text" ? "text" : "play";
function setMode(next: Mode) {
  mode = next;
  byId("play-main").hidden = mode !== "play";
  byId("text-main").hidden = mode !== "text";
  byId("mode").textContent = mode === "play" ? "Text screen (T)" : "Picture screen (T)";
  byId("mode").setAttribute("aria-pressed", String(mode === "text"));
  const url = new URL(location.href);
  if (mode === "text") url.searchParams.set("mode", "text");
  else url.searchParams.delete("mode");
  history.replaceState(null, "", url);
  if (mode === "text") terminal.sync(current.handle("status").lines, current.observe().phase === "won" || current.observe().phase === "lost");
  else play.render();
}
byId("mode").addEventListener("click", () => setMode(mode === "play" ? "text" : "play"));
document.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "t" || event.key === "T")) {
    event.preventDefault();
    setMode(mode === "play" ? "text" : "play");
  } else if (mode === "play" && play.press(event)) event.preventDefault();
});

function start(next: string) {
  seed = next;
  current = createRunSession({ seed });
  byId("seed").textContent = `seed ${seed}`;
  const url = new URL(location.href);
  url.searchParams.set("seed", seed);
  history.replaceState(null, "", url);
  terminal.attach(current);
  play.attach(current);
  byId<HTMLFormElement>("export-form").hidden = true;
  byId("export-toggle").setAttribute("aria-expanded", "false");
  byId("export-status").textContent = "";
}

byId("new-run").addEventListener("click", () => start(freshSeed()));
byId("download").addEventListener("click", () => {
  const replay = current.replay();
  if (replay) save(new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" }), `replay-${seed}.json`);
});

function save(blob: Blob, name: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

const exportForm = byId<HTMLFormElement>("export-form");
const exportStatus = byId("export-status");
byId("export-toggle").addEventListener("click", () => {
  exportForm.hidden = !exportForm.hidden;
  byId("export-toggle").setAttribute("aria-expanded", String(!exportForm.hidden));
});
exportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const replay = current.replay();
  if (!replay) return;
  const field = (id: string) => byId<HTMLInputElement>(id).value;
  const parsed = parseWorkload({ items: field("export-items"), distinct: field("export-distinct"), errorPercent: field("export-error"), memoryKiB: field("export-memory") });
  if (!parsed.ok) {
    exportStatus.textContent = parsed.message;
    return;
  }
  const language = byId<HTMLSelectElement>("export-language").value as Language;
  exportStatus.textContent = "Building...";
  let files: Record<string, string>;
  try {
    files = buildToolkit({ language, replay, workload: parsed.workload, templates: templatesFor(language), constants: sizingConstants(structureConstants()) });
  } catch (error) {
    exportStatus.textContent = `The toolkit could not be built: ${error instanceof Error ? error.message : "unknown error"}`;
    return;
  }
  toolkitZip(files).then(
    (bytes) => {
      save(new Blob([bytes as BlobPart], { type: "application/zip" }), `toolkit-${language}-${seed}.zip`);
      exportStatus.textContent = `Done: ${Object.keys(files).length} files are downloading as a zip.`;
    },
    () => {
      exportStatus.textContent = "The zip could not be written.";
    },
  );
});

// On a narrow screen the structures start folded away so the text has the room; on a wide one they are always open.
const narrow = window.matchMedia("(max-width: 720px)");
const foldPanel = () => (byId<HTMLDetailsElement>("panel-box").open = !narrow.matches);
narrow.addEventListener("change", foldPanel);
foldPanel();
initTheme(byId<HTMLButtonElement>("theme"));
start(seed);
setMode(mode);
