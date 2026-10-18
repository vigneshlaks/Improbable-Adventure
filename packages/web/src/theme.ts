const KEY = "pda-theme";
type Theme = "light" | "dark";

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null; // storage can be blocked; the theme then just follows the system
  }
}

const system = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Applies the saved theme, or the system's, and lets the button switch it. */
export function initTheme(button: HTMLButtonElement): void {
  let current = stored() ?? system();
  const apply = () => {
    document.documentElement.dataset.theme = current;
    button.textContent = current === "dark" ? "Light" : "Dark";
  };
  apply();
  button.addEventListener("click", () => {
    current = current === "dark" ? "light" : "dark";
    apply();
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // the choice then lasts only for this visit
    }
  });
}
