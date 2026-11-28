---
description: Run the gate and fix everything it reports.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /verify

Run `bun run verify`.

It is `bunx x verify`, and it is THE gate — the one CI runs (`.github/workflows/ci.yml`) and the
one `README.md` names. Its `budgets` step builds what it weighs, so nothing runs before it.

Green: say so and stop.

Red: fix every finding, then re-run until green. Each finding carries a stable code, a cause and an
executable `fix:` — **run the `fix:` verbatim before improvising**, and use `bunx x errors explain <CODE>`
when the cause is not enough. `bun run verify --json` gives the same steps machine-readably; `bunx x doctor`
covers the case where the environment, not the code, is what is broken.

Do not narrow the gate to make it pass. There is no `--only` and no `--skip`; disabling a lint rule,
loosening a compiler flag, or deleting an assertion is the same evasion. Fix the code.

Report one line per fix: the code, the file, what changed.
