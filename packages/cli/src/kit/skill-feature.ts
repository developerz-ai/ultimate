// The managed `feature` skill: one request, built end to end by a hive in one checkout — slices on
// disjoint file sets, the coordinator gates once, one PR, done when it is merged. Replaces the
// single-agent `.claude/commands/feature.md` older apps were born with.

import type { NameSet } from '../templates/naming';
import { managedNote } from './managed';

export const featureSkill = (app: NameSet): string => `---
name: feature
description: Build or fix one thing in ${app.kebab} end to end — name the primitive, split the work into path-disjoint slices, run them as a hive in this one checkout, gate once with \`bun run verify\`, open one PR and finish when it is merged. Use for any request that changes behaviour, adds a page, an entity, an action, a job or a fix; not for a plan only (planx) or a red gate only (verify).
argument-hint: <what you want built or fixed, plain language>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Skill
---

${managedNote('skill', 'feature')}

# feature

You are the coordinator of a change to **${app.kebab}**, an Ultimate app. Read \`AGENTS.md\` first —
it is the short form of every rule below, and it wins where the two disagree.

**Done means merged.** One branch, one PR, its CI green — the same \`bun run verify\` — and merged.
A passing unit test is not done; a working \`bunx x dev\` is not done. Report what you ran, never
what you assume passed. Read scope from the words: a request that says "draft", "no PR" or "do not
push" ends there, and your report says where it stopped.

**Given a file set, you are a worker, not the coordinator:** skip the gate, the coordinator runs
it once. Run \`bun test ./<file>\`, \`bunx x test --filter <path>\`, and
\`bunx x verify --only typecheck\` once at the end, then report.

## Request

$ARGUMENTS

You cannot ask anyone anything mid-run. Decide and flag it, or stop and say why — a destructive
migration, a request that needs a ninth primitive, a dependency you cannot justify.

## 1. Name the primitives

Eight, closed: \`entity\` · \`policy\` · \`action\` · \`mutator\` · \`query\` · \`job\` · \`route\` · \`task\`.

| The ask sounds like | It is |
|---|---|
| "store a …", "a … has fields" | \`entity\` |
| "only the owner may …" | \`policy\` |
| "when the user clicks submit …" | \`action\` (writes) / \`mutator\` (writes one entity) |
| "show me the list of …" | \`query\` |
| "send it afterwards", "retry until it works" | \`job\` |
| "a page at /…" | \`route\` |
| "every night at 3am" | \`task\` |

A request that fits none is not one feature: split it until every piece is one of the eight. A new
capability is a **function that returns** one of these, never a new kind of thing. When the answer
is not obvious, dispatch the \`shape\` agent — deciding is its whole job.

## 2. Ask what the change reaches

Before a slice is drawn, read the tree it lands in:

| Question | Ask |
|---|---|
| what does this file reach — routes, actions, jobs, MCP tools, tests | \`bunx x impact <file> --json\`, or dev MCP \`graph.query\` |
| which tests does the branch touch | \`bunx x affected --json\` |
| does it already exist | \`bunx x routes --json\`, \`bunx x actions list --json\`, \`bunx x queries list --json\`, \`bunx x entities list --json\` |
| how does the gate see one path | dev MCP \`verify.narrow\` |

## 3. Cut path-disjoint slices

One slice per boundary agent, each with a file set no other slice touches:

| Slice | Agent | Owns |
|---|---|---|
| data | \`data\` | \`packages/db/\`, every \`entity.ts\` and \`repo.ts\` |
| server | \`server\` | \`policy.ts\`, actions, mutators, queries, jobs, tasks, \`apps/web/api/\` |
| web | \`web\` | \`apps/web/site/\`, pages and UI under \`apps/web/app/\`, \`apps/web/shared/\`, \`packages/ui/\`, catalogs |

Rules of the hive:

- **One checkout.** No worktrees and no copies: every agent edits this tree, on its own paths.
- **A file belongs to one slice.** Two slices that need one file are one slice, or the file is
  yours: edit it yourself before dispatching, so no worker has to.
- **Lowest first.** data, then server, then web, when a later slice imports what an earlier writes.
  Slices with no edge between them run at once.
- **Workers never gate, never commit, never spawn.** Each brief names its file set, the files it
  may read, and "report a collision instead of crossing the line".
- **Visual work starts from the design.** A web slice that adds or restyles a page reads
  \`apps/web/DESIGN.md\` first; when the request names a site to look like, run the
  \`design-research\` skill before the web slice, not after.

Every generated primitive comes from the generator, never by hand:

\`\`\`sh
bunx x g <kind> <name> --feature <slice>     # bunx x g --help is the only list of kinds
\`\`\`

A hand-written primitive compiles and then goes missing from \`bunx x routes\`, \`bunx x actions\`,
\`bunx x queries\`, \`bunx x jobs list\`, \`bunx x tasks\`, \`bunx x policy list\` and
\`x.manifest.json\`. Schema changes too: edit \`entity.ts\`, then \`bunx x db gen "what changed"\`.

## 4. Gate once

When every worker has reported, you — and only you — run the gate:

\`\`\`sh
bun run verify --json
\`\`\`

Red is instructions: each finding carries a stable code, a cause and a \`fix:\`. Hand the finding to
the \`verify\` skill — it checks where a \`fix:\` line came from before running it. Never narrow the
gate to pass: \`--only <step>\` prints \`NOT A GATE RUN\`, there is no \`--skip\`, and loosening a
lint rule or a compiler flag is the same move.

While iterating, narrow the feedback, not the gate:

| | Command |
|---|---|
| one test file | \`bun test ./<path>/<file>.test.ts\` |
| tests the branch reaches | \`bunx x test --affected\`, or dev MCP \`tests.run\` |
| one gate step | \`bunx x verify --only <step> --json\` — \`NOT A GATE RUN\` |
| the files you touched | \`bunx @biomejs/biome check --write <paths>\` |
| a broken environment | \`bunx x doctor\` |

## 5. One PR, then merged

\`\`\`sh
git status                       # only the slices' files, nothing stray
git switch -c <type>/<slug>      # from the default branch, when not already on one
\`\`\`

Commit, push, open one PR whose body lists each slice, its files and the gate verdict. Then:

| Step | Command |
|---|---|
| CI on this branch | \`bunx x ci runs --json\` |
| what CI tested | \`bunx x ci tested --json\` |
| review threads | \`bunx x pr review --json\` — answer each with \`bunx x pr reply\`, close with \`bunx x pr resolve\` |

A red CI run is the same gate as yours: read its findings, fix on the branch, push again. Merge when
CI is green and no thread is open.

## Hard rules

Never a bare \`throw new Error\` — \`defineError({ code, title, status, cause, fix })\` from
\`@ultimat3/core/page\`. No \`any\`; \`unknown\` and parse. Named exports only. \`import type\` for
types. Tests next to the source, failure case first. One file, one job. Every user-facing string
through \`t()\`. Semantic tokens, never a raw colour. Every date with an explicit IANA time zone.
Money is integer minor units plus an ISO code. Bun only.

## Output

\`\`\`
Primitives: <which of the eight, and where>
Slices:     <slice> → <agent> · <files>              (one line each)
Generated:  <the generator commands you ran, one per line>
Gate:       bun run verify ✓ | ✗ <failing steps>
PR:         <url> · CI ✓ | ✗ · merged | stopped at <step>, because <why>
Deferred:   <what you did not do, and why>           [never omit this line]
\`\`\`
`;
