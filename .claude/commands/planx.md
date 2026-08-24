---
description: Write a concise, self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Agent, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. Plan only — no implementation, no code execution, no edits outside the plan dir.

## Goal
$ARGUMENTS

## Steps

1. **Resolve path.** Run `date +%Y`, `date +%m`, `date +%d`. Dir = `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title, max 5 words. Final plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Explore.** `Agent` (subagent_type=Explore, thoroughness="very thorough"): existing patterns and the files to touch (`file:line`), **which tier each package sits in and whether the change respects `scripts/lib/tiers.ts`**, which of the eight primitives the feature is, the error codes involved, tests (`unit` vs the opt-in `contract` / `live` / `job` / `e2e` / `eval` suffixes), and gotchas. Prefer `codegraph_explore` for structural lookups over grep. Skip only for trivial asks.

   **Falsify the ask before planning it.** Read the code, not just the request. If a claim in the prompt is already false in the tree, say so in `overview.md` under *Risks* with the `file:line` that disproves it, and plan what is actually true.

3. **Write the plan as multiple files** in the plan dir — never one big `plan.md`. Always produce an `overview.md` index plus one `<NN>-<aspect>.md` per separable area (e.g. `01-entity.md`, `02-policy.md`, `03-action.md`, `04-route.md`, `05-cli.md`, `06-docs.md`). **Split by tier, then by area** — a slice must be independently executable, and imports only go down, so a tier-0/1 slice lands before the tier-3 slice that adopts it. Match the house style in `docs/idea/` and `docs/architecture/` — lead with the rule, fragments over sentences, tables for any ≥3-row structure, `file:line` refs, no meta-framing, no trailing summary.

   **`overview.md`** — the map. Sections:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Stack facts the executor needs (Bun-only, Postgres with no ORM, SolidJS 1.9.x + our own router, SCSS modules + tokens, `@ultimat3/*` at tier N — only what's relevant).
- Which primitive this is: `entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`. If it fits none, the design is wrong — say so here instead of planning a ninth.
- Reference patterns: `packages/<pkg>/src/<area>/<thing>.ts:12` — follow this for Z.

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
Land lowest tier first. An import that would go up or sideways is a design error, not a `boundaries` exception.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line: what it covers.
2. [`02-<aspect>.md`](02-<aspect>.md) — ...

## Done when
- Verifiable acceptance criteria spanning the whole feature, ending in `bun run verify` green.

## Risks / open questions
- Anything the executor must decide or watch. Include any claim in the ask that the code disproves.
```

   **Each `<NN>-<aspect>.md`** — one slice of work. Sections:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">. Tier: <n>.

## Files to change
- `path:line` — what changes, why.

## Steps
1. Ordered, concrete actions. Reference `Class#method` / `file:line`, don't restate.

## Tests
- What to add/run. Tests next to source as `<file>.test.ts`. A test that can't fail isn't a test.
- Command: `bun test packages/<pkg>/src/<file>.test.ts`, or `bun test -t '<name>'` for one.

## Done when
- Verifiable acceptance criteria for this slice.
```

4. **Write a `status.yml`** in the plan dir (alongside `overview.md`) — the live tracker for this plan. New plans start `not_started` / `0%`. Get `created_by` + `owner` from `git config user.name`. Leave `worked_by` empty — the executor sets it to their own `git config user.name` when they pick the plan up, so a plan written by one person can be worked by another. Shape:

```yaml
plan: <1NN>-<slug>
title: <human title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>   # who authored the plan
worked_by: ""              # who is executing it; empty = unclaimed; executor fills with their git user.name
owner: <git config user.name>
percent: 0                 # 0–100, overall completion
current_focus: ""          # where it's at right now / next slice to pick up
slices:                    # one row per <NN>-<aspect>.md slice
  - file: 01-<aspect>.md
    tier: 0                # lowest tier the slice touches; execution order follows it
    status: not_started      # not_started | in_progress | complete
    percent: 0
evidence: []               # commits/PRs proving progress, e.g. ["#53", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

   Keep `status.yml` machine-readable (valid YAML, the enums above). It's the one file in the plan dir that IS a tracker — the `.md` slices stay reference maps (no checkboxes there).

## Rules

- Compact English. Fragments over sentences. `file:line` and `Class#method` refs over prose. Tables for structured data. Date load-bearing claims `As of <YYYY-MM>`.
- Reference-only: point at code, don't paste it or re-explain it ("follow `x.ts` but …").
- No checkboxes (`[ ]`). Plain bullets. The plan is a reference map, not a tracker.
- Multiple files always: `overview.md` + `<NN>-<aspect>.md` slices. Never a single `plan.md`.
- Self-contained: executor reads only `overview.md`, the slice it's on, and the files those cite.

### The axioms the plan must obey ([`CLAUDE.md`](../../CLAUDE.md))

Any plan that violates one is wrong, not "a tradeoff":

1. **One way to do each thing.** A second path is the tax agents pay. If the plan adds an alternative to something that exists, replace the original or don't plan it.
2. **Define once, project everywhere.** One `action` → HTTP + OpenAPI + typed client + job handle + MCP tool + tests. A plan that hand-writes one of those projections is planning drift.
3. **Enforced, not documented.** Every slice that introduces a convention names the build error that enforces it. "We'll remember to" is not a plan step.
4. **Errors are instructions.** New failure → a stable `X_SCREAMING_SNAKE` code declared in the owning package's registry, a cause, an **executable** `fix:`, a row in [`wiki/Error-Codes.md`](../../wiki/Error-Codes.md). Shipped codes never change.
5. **One command means shippable.** Every plan ends at `bun run verify` green — all 20 steps.
6. **Static path never pays for the app path.** `site/` is 0kb JS and may not import `app/`; `shared/` is a leaf.
7. **Deploy anywhere = containers only.** No platform primitives in the framework.

### Stack rules

- **Bun only.** No Node APIs unless via `node:` and unavoidable, with a comment saying why. No new dependencies without a reason stated in the plan.
- **Eight primitives, closed.** A new capability arrives as a **factory over an existing primitive** (see `llm()` in [`packages/ai/src/llm.ts`](../../packages/ai/src/llm.ts)), never as a ninth kind of thing.
- **Tiers 0–5, imports only go DOWN** — never sideways within a tier, never up. [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) is the executable copy and the prose table in `CLAUDE.md` must agree. Adding a package means picking its tier first; if it fits none, the design is wrong.
- No `any` (use `unknown` + a schema parse). No default exports. `import type` for type-only imports. Named re-exports in `src/index.ts`, never `export *`.
- Never throw a bare `Error` — subclass `UltimateError`.
- SRP: one file, one job, target < 200 LOC, hard ceiling ~500 (the `filesize` step).
- `--json` on every CLI command and every error.
- No hardcoded user-facing strings (`t()`), no raw colours (semantic tokens only), no float money (`{ minor, currency }`), no date without an explicit IANA `timeZone`.
- Route files: `page.tsx` under `site/`/`app/`, `route.ts` under `api/` — the directory is the URL.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands). A plan that adds a package plans both.

### Commands the plan cites

| Task | Command |
|---|---|
| the gate | `bun run verify` |
| typecheck / lint | `bun run typecheck` · `bun run lint` (`lint:fix`) |
| import boundaries | `bun run boundaries` |
| one test file / name | `bun test <path>` · `bun test -t '<name>'` |
| the app gate (both tracked apps) | `bun run scripts/reference-app-gate.ts` |
| regenerate the manifest | `bun run manifest` (never hand-edit `framework.manifest.json`) |
| new framework package | `bun run scripts/new-package.ts <name> --tier <n>` |
| the CLI, in-repo | `bun run x -- <args>` |

### Cross-repo work

One `<NN>-<aspect>.md` per repo. Infrastructure lives in `../infrastructure` and is edited **from its own repo**, never from here — a slice touching it says so in its header. **Never name another product, client or repository in a plan file**: plans are committed. Describe a comparison generically ("a sibling deployment on the same cluster"), and keep measured facts without the source's name.

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, … (one per area, tier order)
  + status.yml (tracker — status/owner/percent/current_focus)
Next: run an executor on overview.md, or `/feature` it.
```
