---
description: Write a self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another agent to implement.
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Bash, Task
---

Produce a plan another agent can execute with **zero extra context**. Plan only — no
implementation, no edits outside the plan directory. Cheap to be wrong here; expensive in `/feature`.

## Goal

$ARGUMENTS

## Steps

1. **Resolve the path.** `date +%Y`, `date +%m`, `date +%d` → `docs/plans/<YYYY>/<MM>/<DD>/`. Glob
   for `1*`; the next number is the highest existing `1NN-*` + 1, else `101`. Slug is kebab-case,
   ≤5 words.
2. **Explore read-only, in parallel.** Ask CodeGraph for structure, not grep. Find the existing
   pattern to follow and cite it as `file:line`. **Distrust the paperwork** — check any existing
   plan, spec or doc against the code and `git log` before planning off it, and say plainly which
   claims you falsified.
3. **Name the primitives.** Every slice must land as one or more of the eight: `entity` `policy`
   `action` `mutator` `query` `job` `route` `task`. If part of the goal fits none, say so in
   *Risks* — do not invent a ninth, and do not quietly reshape the goal to fit.
4. **Write MULTIPLE files, never one `plan.md`.** `overview.md` plus one `<NN>-<aspect>.md` per
   separable area, each independently executable and short. The natural split here is by layer:
   `01-entities.md`, `02-policy.md`, `03-actions-queries.md`, `04-jobs.md`, `05-routes-ui.md`,
   `06-tests.md`.

   **The slice boundary IS the agent's file set IS the PR.** Split so no two slices need the same
   file — two agents that must edit one file are one slice.

```markdown
# <Title>                          ← overview.md, the map

## Goal
One or two sentences: what, and why.

## Context
- Only the facts the executor needs.
- Pattern to follow: `apps/web/app/posts/actions.ts:33` — copy this shape.

## Slices (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line, and the exclusive file set it owns.

## Done when
- Verifiable acceptance criteria spanning the whole feature. `bin/check` green is necessary,
  never sufficient — name the behaviour a person can observe.

## Risks / open questions
- Anything the executor must decide, and anything I could not verify.
```

```markdown
# <NN> — <Aspect>                   ← one slice

> Part of [`overview.md`](overview.md). Depends on: <NN or "none">.
> Owns exclusively: `path/**`. Never edits outside it — stop and report instead.

## Files to change
- `path:line` — what changes, and why.

## Steps
1. Ordered, concrete. Reference `file:line`; do not restate code.

## Tests
- Failure case first. Which suite: unit / contract / live / job / e2e.

## Done when
- Verifiable acceptance criteria for this slice alone.
```

5. **Write `status.yml`** beside `overview.md`. It is the **only** tracker — the `.md` slices stay
   reference maps and carry **no checkboxes**. Fields: `created_by` (from `git config user.name`),
   `owner`, an empty `worked_by` so someone else can pick it up, `percent`, `slices[]` each with a
   status enum, and `evidence` for the commits and PRs that close them.

Compact English. Fragments over sentences. Tables for anything with three or more rows.
Reference, never paste. Respect `CLAUDE.md`. Report the plan directory path when you are done.
