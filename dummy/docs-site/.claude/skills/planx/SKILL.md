---
name: planx
description: Write a plan for docs-site to docs/plans/ as a directory — overview.md, one file per path-disjoint slice and a status.yml — for a hive of agents to execute with the feature skill. Plan only; nothing outside the plan directory changes. Use when the request asks for a plan, a design, a breakdown, or when the work is too large for one feature run.
argument-hint: [what you want planned]
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Bash(bunx x routes:*)
  - Bash(bunx x actions:*)
  - Bash(bunx x queries:*)
  - Bash(bunx x entities:*)
  - Bash(bunx x impact:*)
  - Bash(bunx x docs:*)
---

<!-- Managed by Ultimate: `bunx x kit` rewrites this file and `bunx x verify` refuses an edit (X_KIT_DRIFT). To change it, copy it to `.claude/skills/app-planx/SKILL.md` and add "planx" to "off" in .claude/kit.json. -->

# planx

Plan only. No implementation, no edit outside the plan directory.

## Goal

$ARGUMENTS

## 1. Read the code before planning against it

Every claim in the ask is a premise to check. One the tree disproves goes under *Risks* in
`overview.md` with the `file:line` that disproves it, and the plan follows what is true.

| Question | Ask |
|---|---|
| what exists | `bunx x routes --json`, `bunx x actions list --json`, `bunx x queries list --json`, `bunx x entities list --json` |
| what a file reaches | `bunx x impact <file> --json`, or dev MCP `graph.query` |
| how the framework does it | `bunx x docs "<question>"` |

## 2. Resolve the directory

The date comes from Bun in a named zone — the host's ambient one gives two answers on two machines
at the same instant, and this app formats no date without an explicit IANA time zone:

```sh
bun -e "console.log(new Intl.DateTimeFormat('en-CA', { timeZone: 'Etc/UTC' }).format(new Date()))"
```

Then `docs/plans/<YYYY-MM-DD>-<slug>/`. Slug kebab-case, five words at most.

## 3. Write the directory

```
docs/plans/<YYYY-MM-DD>-<slug>/
  overview.md        goal, primitives, slice table, order, done-when, risks
  01-<slice>.md      one file per slice, numbered in the order they may start
  02-<slice>.md
  status.yml         one entry per slice: the executors' tracker
```

### `overview.md`

```markdown
# <Title>

## Goal
One or two sentences: what, and why.

## Primitives
Which of the eight (entity · policy · action · mutator · query · job · route · task) and which
feature slice each lives in. One that fits none means the design is wrong — say so here.

## Slices
| # | Slice | Agent | Owns (paths) | Starts after |
|---|---|---|---|---|

## Done when
- Acceptance criteria, ending in `bun run verify` green and the one PR merged through `feature`'s
  merge gate: every required check on its head passed, the review included, and every thread resolved.

## Risks
- What an executor must decide, and every premise the code disproved.
```

### Each slice file

```markdown
# <NN> — <slice>

Agent: data | server | web.   Owns: <paths — disjoint from every other slice>.

## Files to change
- `path:line` — what changes, and why.

## Steps
1. Ordered, concrete. The `bunx x g` invocation where one applies. Point at code, never paste it.

## Tests
- Next to the source as `<file>.test.ts`, failure case first. The command that runs them.

## Done when
- What this slice proves on its own; the gate is the coordinator's, once.
```

### `status.yml`

```yaml
plan: <YYYY-MM-DD>-<slug>
slices:
  - id: "01"
    name: <slice>
    agent: data
    state: todo        # todo | doing | done | blocked
    blocked_by: []     # slice ids
    notes: ""
```

## Rules

- **Path-disjoint.** No path in two slices' *Owns*. A file two slices need is its own earlier slice
  or the coordinator's, named in `overview.md`.
- **Lowest first.** data before server before web where one imports what another writes.
- Fragments over sentences. `file:line` over prose. Tables for anything with three or more rows.
- No checkboxes in the markdown: `status.yml` is the tracker, the markdown is the map.
- The plan obeys the app's rules — generators over hand-written files, no surface boundary crossed,
  a stable error code with a runnable `fix:` for every new failure, `bun run verify` last.

## Output

```
✓ docs/plans/<YYYY-MM-DD>-<slug>/ (overview.md, <n> slices, status.yml)
Next: run it with the feature skill.
```
