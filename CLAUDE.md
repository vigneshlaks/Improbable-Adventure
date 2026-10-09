# Project conventions

Read SPEC.md before any task. It is the source of truth; if code and spec disagree, stop and ask.

## Rules
- packages/engine is pure: no I/O, no Date.now, no Math.random. All randomness uses the run's seeded PRNG.
- Engine must never import from other packages.
- Every capitalized constant comes from packages/content/balance.json. No magic numbers.
- Each structure gets unit tests AND a statistical error test against its bound in SPEC.md.
- Never "fix" a statistical test by loosening its bound without asking.
- Run `pnpm test && pnpm lint` before declaring a task done.

## Commands
- pnpm test | pnpm lint | pnpm sim <cmd> | pnpm cli | pnpm dev (web)

## Notes
- At the end of each working session, append to notes/dev/YYYY-MM-DD.md (detailed, for Claude) and notes/summary/YYYY-MM-DD.md (short, plain language, for the user).
- Read the latest notes/dev entry at the start of a session.
