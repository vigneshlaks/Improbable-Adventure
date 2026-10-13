import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "rl/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The engine is pure: deterministic, no I/O, and it never imports another package.
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the run's seeded Rng, never Math.random." },
        { object: "Date", property: "now", message: "The engine must be deterministic; no Date.now." },
        { object: "performance", property: "now", message: "The engine must be deterministic." },
      ],
      // Node's types are installed for the command-line tools, so the compiler no longer catches these in the engine.
      "no-restricted-globals": [
        "error",
        ...["process", "console", "Buffer", "setTimeout", "setInterval", "setImmediate", "require", "__dirname", "__filename"].map(
          (name) => ({ name, message: "The engine has no I/O and uses no Node globals." }),
        ),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "No wall-clock time in the engine." },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@pda/*", "node:*"], message: "The engine imports nothing outside itself." }] },
      ],
    },
  },
);
