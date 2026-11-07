---
description: Build or fix one thing in docs-site end to end — name the primitive, generate it, wire it inside the boundaries, gate it with `bun run verify`.
argument-hint: <what you want built or fixed, plain language>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Skill
---

# /feature

You are a senior engineer on **docs-site**, an Ultimate app. Read `AGENTS.md` before designing
anything — it is the short form of every rule below, and it wins where the two disagree.

**Done means `bun run verify` green.** A passing unit test is not done. A working `bunx x dev` is not done.
Report what you actually ran, never what you assume passed.

## Request
$ARGUMENTS

**The prompt is the context.** Scope, autonomy, whether to commit: read it from the words. Stop for
a real blocker — a destructive migration, a request that needs a ninth primitive, a dependency you
cannot justify. You cannot ask a subagent's user anything, so decide and flag it, or stop and say
why.

## 1. Name the primitive first

Eight, closed: `entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`.

| The ask sounds like | It is |
|---|---|
| "store a …", "a … has fields" | `entity` |
| "only the owner may …" | `policy` |
| "when the user clicks submit …" | `action` (writes) / `mutator` (writes one entity) |
| "show me the list of …" | `query` |
| "send it afterwards", "retry until it works" | `job` |
| "a page at /…" | `route` |
| "every night at 3am" | `task` |

A request that fits none is not one feature — split it until every piece is one of the eight. There
is no ninth: a new capability is a **function that returns** one of these, never a new kind of thing.
Say which primitive and which slice out loud before you write a file. When the answer is not
obvious, hand the request to the `shape` subagent — that pass is the whole reason it exists.

## 2. Generate it — do not hand-write it

```sh
bunx x g <kind> <name> --feature <slice>     # bunx x g --help is the only list of kinds
```

The generator writes the source, its test and its i18n keys as one unit and registers it. A
hand-written primitive compiles and then goes missing from `bunx x routes`, `bunx x actions`, `bunx x queries`,
`bunx x jobs`, `bunx x tasks`, `bunx x policy list` and `x.manifest.json` — every surface that is supposed to
project it. Edit what the generator wrote; never reproduce it.

Schema changes are generated too: edit `entity.ts`, then `bunx x db gen "what changed"`. Never hand-write
SQL into `packages/db/migrations/`.

## 3. Wire it inside the boundaries

| Boundary | The rule | What breaks without it |
|---|---|---|
| `apps/web/site/` | 0kb JS, may not import `apps/web/app/` | the static path pays the app's bundle |
| `apps/web/app/` | authed, streaming, hydrated | — |
| `apps/web/api/` | actions and queries only, collected by `defineApi()` — no route file | a second HTTP surface |
| `apps/web/shared/` | a leaf: imports nothing of yours | an import cycle across surfaces |
| `repo.ts` | the only file that touches the database | authz bypassed by a raw read |
| routes | call actions and queries, never a repo | policy skipped |

Route files: `page.tsx` under `site/`/`app/`, and none under `api/`. **The directory is the URL** —
the filename never is. One interactive control on a 0kb page is an island: `bunx x g island <name> --at <dir>`.

## 4. Gate it

```sh
bun run verify          # the gate. green = shippable
bun run verify --json   # the same, machine-readable
```

`bun run verify` is `bunx x verify`, the whole gate: its `budgets` step builds what it weighs when
`.x/build-stats.json` is missing or older than the source. CI runs this same script —
`.github/workflows/ci.yml` is `bun run setup` and then `bun run verify`, nothing else.

Red is instructions, not a verdict: **every finding carries an executable `fix:` — run it verbatim
before improvising**, and `bunx x errors explain <CODE>` expands any code it names. Never narrow the gate
to make it pass: there is no `--only` and no `--skip`, on purpose, and disabling a lint rule or
loosening a compiler flag is the same move wearing a different hat.

While you iterate, narrow the *feedback*, not the gate:

| | Command |
|---|---|
| one test file | `bun test <path>/<file>.test.ts` |
| one test by name | `bun test -t '<name>'` |
| a whole type | `bunx x test unit` · `bunx x test contract` · `bunx x test e2e` |
| lint the files you touched | `bunx biome check --write <paths>` |
| types, once, when otherwise done | `bun run typecheck` |
| a broken environment | `bunx x doctor` |

## 5. Hard rules

Never a bare `throw new Error` — declare each code once with `defineError` from `@ultimat3/core`:
a stable code, a title, a status, a cause and a runnable `fix:`.
No `any`; use `unknown` and parse. Named exports only. `import type` for types.
Tests next to the source as `<file>.test.ts`, failure case first — a test that cannot fail is not a
test. One file, one job. Every user-facing string through `t()`. Semantic tokens, never a raw
colour. Every date formatted with an explicit IANA time zone. Money is integer minor units plus an
ISO code, never a float. Bun only.

## Output

```
Primitive:  <which of the eight>    Slice: <dir>
Generated:  <every `bunx x g` command you ran>
Changed:    <files>
Gate:       bun run verify ✓ | ✗ <failing steps>
Deferred:   <what you did not do, and why>      [never omit this line]
```
