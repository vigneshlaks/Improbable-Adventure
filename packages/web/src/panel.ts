import type { StructureVisual } from "@pda/ui-core";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function draw(visual: StructureVisual): HTMLElement {
  const body = element("div", `visual ${visual.shape}`);
  body.setAttribute("aria-hidden", "true"); // the caption and readout say the same in words
  if (visual.shape === "heatmap") body.style.gridTemplateColumns = `repeat(${visual.columns}, 1fr)`;
  if (visual.shape === "meter") body.style.gridTemplateColumns = `repeat(${Math.min(visual.cells.length, 64)}, 1fr)`; // a short strip still spans the width
  for (const value of visual.cells) {
    const cell = element("span", "cell");
    if (visual.shape === "bars") cell.style.height = `${Math.max(4, value * 100)}%`;
    else cell.style.setProperty("--level", String(value));
    body.append(cell);
  }
  return body;
}

/** Redraws the side panel from the structures' current state. */
export function renderPanel(panel: HTMLElement, visuals: StructureVisual[]): void {
  panel.replaceChildren(
    ...(visuals.length === 0
      ? [element("p", "empty", "Nothing deployed yet. Deploy a structure to watch it fill.")]
      : visuals.map((visual) => {
          const card = element("figure", "card");
          card.append(element("figcaption", "name", `${visual.slot + 1}. ${visual.label}`), draw(visual), element("p", "caption", visual.caption), element("p", "readout", visual.readout));
          return card;
        })),
  );
}
