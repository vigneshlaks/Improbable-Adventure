import type { RunSession } from "@pda/ui-core";

export interface Terminal {
  /** Starts the transcript over for a new session. */
  attach(session: RunSession): void;
  /** Brings the screen up to date after play elsewhere: prints lines and redraws the prompt. */
  sync(lines: string[], over: boolean): void;
}

/** The text side of the page: a transcript, the prompt, a line of input with history, and buttons for likely commands. */
export function createTerminal(parts: {
  transcript: HTMLElement;
  chips: HTMLElement;
  form: HTMLFormElement;
  prompt: HTMLElement;
  input: HTMLInputElement;
  onChange(session: RunSession, ended: boolean): void;
}): Terminal {
  const { transcript, chips, form, prompt, input } = parts;
  let session: RunSession | null = null;
  let ended = false;
  const history: string[] = [];
  let cursor = 0;

  const print = (lines: string[], className = "") => {
    const block = document.createElement("pre");
    block.className = className;
    block.textContent = lines.join("\n");
    transcript.append(block);
    transcript.scrollTop = transcript.scrollHeight;
  };

  function refresh() {
    if (!session) return;
    prompt.textContent = ended ? "The run is over." : session.prompt();
    input.disabled = ended;
    chips.replaceChildren(
      ...(ended ? [] : session.suggestions()).map((command) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = command;
        chip.addEventListener("click", () => submit(command));
        return chip;
      }),
    );
    parts.onChange(session, ended);
  }

  function submit(line: string) {
    if (!session || ended) return;
    print([`${session.prompt()}${line}`], "echo");
    if (line.trim() !== "") history.push(line);
    cursor = history.length;
    const reply = session.handle(line);
    if (reply.lines.length > 0) print(reply.lines);
    ended = reply.done;
    refresh();
    if (!ended) input.focus();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const line = input.value;
    input.value = "";
    submit(line);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    cursor = Math.min(history.length, Math.max(0, cursor + (event.key === "ArrowUp" ? -1 : 1)));
    input.value = history[cursor] ?? "";
  });

  return {
    sync(lines, over) {
      ended = over;
      if (lines.length > 0) print(lines);
      refresh();
      if (!ended) input.focus();
    },
    attach(next) {
      session = next;
      ended = false;
      history.length = 0;
      cursor = 0;
      transcript.replaceChildren();
      print(next.opening());
      refresh();
      input.value = "";
      input.focus();
    },
  };
}
