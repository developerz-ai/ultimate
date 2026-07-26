---
description: Run the shippability gate and fix what it reports
---

Run `bun run verify`.

If it fails: fix every reported failure, then re-run until green. Report each fix in one line. Do not narrow the scope of the gate to make it pass, and do not disable a lint rule or a strict compiler flag to unblock yourself — fix the code.

Every framework error carries a `fix:` command. Run it before improvising.
