---
description: Scaffold a new @ultimat3/* framework package at the correct tier
argument-hint: <name> <tier>
---

Add the framework package `$1` at tier `$2`.

1. Confirm the tier against `TIERS` in `scripts/lib/tiers.ts`: the **lowest** tier its real imports
   allow. If the package fits no tier cleanly, stop and say why — the design is wrong, not the table.
2. `bun run scripts/new-package.ts $1 --tier $2` — writes the package and its root `tsconfig.json`
   reference.
3. Add `$1` to `TIERS` in `scripts/lib/tiers.ts` **and** to each prose copy — the root `CLAUDE.md`,
   `docs/architecture/01-package-map.md`, `wiki/Project-Layout.md`. The script writes none of them;
   `scripts/tier-table-drift.test.ts` fails when they disagree.
4. Fill in `src/index.ts` (explicit named re-exports), `src/errors.ts`, `README.md`, `CLAUDE.md` —
   its Commands line as `bun test ./packages/$1/`, run from the repo root.
5. At least two tests that would catch a real regression: `bun test ./packages/$1/`.
6. `bun run boundaries`, then `bun run verify`.
