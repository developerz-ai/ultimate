---
description: Scaffold a new @ultimat3/* framework package at the correct tier
argument-hint: <name> <tier>
---

Add the framework package `$1` at tier `$2`.

1. Confirm the tier is right against the table in `docs/architecture/00-conventions.md`. If the package doesn't fit a tier cleanly, stop and say why — the design is wrong, not the table.
2. Run `bun run scripts/new-package.ts $1 --tier $2`.
3. Fill in `src/index.ts`, `src/errors.ts`, `README.md`, `CLAUDE.md`.
4. Add the reference to the root `tsconfig.json`.
5. Write at least two tests that would catch a real regression.
6. `bun run verify`.
