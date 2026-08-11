---
description: Return the working tree and the dev database to a known-good state.
---

Reset to a clean slate. Destructive — confirm the first item with me before running anything else.

1. **Show me what would be lost.** `git status --short` and `git stash list`. If there is
   uncommitted work you did not create in this session, stop and ask. Never `git stash`.
2. `bun install`
3. `x db reset` — drops the embedded dev database and re-applies every migration.
4. `bun run scripts/db/seed.ts` — the deterministic fixture graph, including the `user/user` and
   `admin/admin` demo accounts.
5. `x doctor --json` — every finding prints the exact command that fixes it. Fix them in order.
6. `bin/check`

Report the final state as a table: git clean yes/no, migrations applied, rows seeded, doctor
findings remaining, gate green/red. If the gate is red, name the failing steps — do not summarize
them as "some failures".
