---
description: Set up the local dev environment and prove it works. Run this first, in a fresh clone.
allowed-tools: Read, Edit, Bash, Grep, Glob
---

Get this app running on this machine. Environment only — **do not ask me about features and do not
write app code.** That is `/idea`.

No questions unless you are genuinely blocked: `x doctor` prints a runnable fix for every finding,
so apply them rather than reporting them back to me.

## Steps

```
bun install
x doctor --json
x db migrate
bun run scripts/db/seed.ts        # skip if the app has no seed yet
bin/check
```

Then boot it and **look at it**:

```
x dev
```

Open the URL and confirm a page renders **with content on it** — not "the server started", not a
200 with an empty body. Check `/_x` too: every panel that has a source should answer.

## What you must not do

- Do not hand-write a `DATABASE_URL`, a port, or any connection string. Unset means embedded:
  Postgres runs in-process, events are in-process, storage is a local directory. If that is not
  working, it is a bug in the harness and I want to know — routing around it hides the next one.
- Do not `git stash`, do not commit, do not create a branch.
- Do not "fix" a red gate by weakening a test, a type or a lint rule. The guard is the asset.

## Known local traps

- `x dev --port N` moves the HTTP listener **only**. The metrics endpoint always binds
  `METRICS_PORT` (default 9090) and the sync role takes `PORT + 1`, so a second `x dev` collides
  even on a different `--port`. Use `METRICS_PORT=<free> x dev --port <free>`.
- Every route 404ing, including ones you can see on disk, means the **module scan** died on an
  unresolvable import — registration *is* that scan. Read the whole boot log, not the last line.
- A test that passes alone and fails in the suite is shared-fixture contention, not your code.

## Report

A table: `bun install` ok, doctor findings remaining, migrations applied, seed rows, gate
green/red, and the URL of a page you actually loaded. If the gate is red, name the failing steps
and their `X_*` codes — never "some failures".

Next: `/idea <what you want to build>`.
