// The slash commands `x new` writes into `.claude/commands/`: the three workflows every audited
// repo re-invented by hand — build a feature, plan one, run the gate. Deliberately NOT one command
// per generator: `x g <kind>` already is that command, and a slash wrapper over a shipped CLI
// command is the second path axiom 1 forbids.

import type { GeneratedFile, NameSet } from './naming';

const feature = (app: NameSet): string => `---
description: Build or fix one thing in ${app.kebab} end to end — name the primitive, generate it, wire it inside the boundaries, gate it with \`x verify\`.
argument-hint: <what you want built or fixed, plain language>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Skill
---

# /feature

You are a senior engineer on **${app.kebab}**, an Ultimate app. Read \`AGENTS.md\` before designing
anything — it is the short form of every rule below, and it wins where the two disagree.

**Done means \`x verify\` green.** A passing unit test is not done. A working \`x dev\` is not done.
Report what you actually ran, never what you assume passed.

## Request
$ARGUMENTS

**The prompt is the context.** Scope, autonomy, whether to commit: read it from the words. Stop for
a real blocker — a destructive migration, a request that needs a ninth primitive, a dependency you
cannot justify. You cannot ask a subagent's user anything, so decide and flag it, or stop and say
why.

## 1. Name the primitive first

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

A request that fits none is not one feature — split it until every piece is one of the eight. There
is no ninth: a new capability is a **function that returns** one of these, never a new kind of thing.
Say which primitive and which slice out loud before you write a file. When the answer is not
obvious, hand the request to the \`shape\` subagent — that pass is the whole reason it exists.

## 2. Generate it — do not hand-write it

\`\`\`sh
x g <kind> <name> --feature <slice>     # x g --help is the only list of kinds
\`\`\`

The generator writes the source, its test and its i18n keys as one unit and registers it. A
hand-written primitive compiles and then goes missing from \`x routes\`, \`x actions\`, \`x queries\`,
\`x jobs\`, \`x tasks\`, \`x policy list\` and \`x.manifest.json\` — every surface that is supposed to
project it. Edit what the generator wrote; never reproduce it.

Schema changes are generated too: edit \`entity.ts\`, then \`x db gen "what changed"\`. Never hand-write
SQL into \`packages/db/migrations/\`.

## 3. Wire it inside the boundaries

| Boundary | The rule | What breaks without it |
|---|---|---|
| \`apps/web/site/\` | 0kb JS, may not import \`apps/web/app/\` | the static path pays the app's bundle |
| \`apps/web/app/\` | authed, streaming, hydrated | — |
| \`apps/web/api/\` | actions only, \`route.ts\` | a second HTTP surface |
| \`apps/web/shared/\` | a leaf: imports nothing of yours | an import cycle across surfaces |
| \`repo.ts\` | the only file that touches the database | authz bypassed by a raw read |
| routes | call actions and queries, never a repo | policy skipped |

Route files: \`page.tsx\` under \`site/\`/\`app/\`, \`route.ts\` under \`api/\`. **The directory is the URL** —
the filename never is. One interactive control on a 0kb page is an island: \`x g island <name> --at <dir>\`.

## 4. Gate it

\`\`\`sh
x verify                # the gate. green = shippable
x verify --json         # the same steps, machine-readable
\`\`\`

Red is instructions, not a verdict: **every finding carries an executable \`fix:\` — run it verbatim
before improvising**, and \`x errors explain <CODE>\` expands any code it names. Never narrow the gate
to make it pass: there is no \`--only\` and no \`--skip\`, on purpose, and disabling a lint rule or
loosening a compiler flag is the same move wearing a different hat.

While you iterate, narrow the *feedback*, not the gate:

| | Command |
|---|---|
| one test file | \`bun test <path>/<file>.test.ts\` |
| one test by name | \`bun test -t '<name>'\` |
| a whole type | \`x test unit\` · \`x test contract\` · \`x test e2e\` |
| lint the files you touched | \`bunx biome check --write <paths>\` |
| types, once, when otherwise done | \`bun run typecheck\` |
| a broken environment | \`x doctor\` |

## 5. Hard rules

Never a bare \`throw new Error\` — subclass \`UltimateError\` with a stable code, a cause and a
runnable \`fix:\`. No \`any\`; use \`unknown\` and parse. Named exports only. \`import type\` for types.
Tests next to the source as \`<file>.test.ts\`, failure case first — a test that cannot fail is not a
test. One file, one job. Every user-facing string through \`t()\`. Semantic tokens, never a raw
colour. Every date formatted with an explicit IANA time zone. Money is integer minor units plus an
ISO code, never a float. Bun only.

## Output

\`\`\`
Primitive:  <which of the eight>    Slice: <dir>
Generated:  <the x g invocations you ran>
Changed:    <files>
Gate:       x verify ✓ | ✗ <failing steps>
Deferred:   <what you did not do, and why>      [never omit this line]
\`\`\`
`;

const planx = (app: NameSet): string => `---
description: Write a short, self-contained plan for ${app.kebab} to docs/plans/, for another agent to execute.
argument-hint: [what you want done]
allowed-tools: Read, Glob, Grep, Bash, Write, Agent
---

# /planx

Plan only. No implementation, no edits outside the plan file.

## Goal
$ARGUMENTS

## Steps

1. **Read the code before planning against it.** If a claim in the ask is already false in the tree,
   say so under *Risks* with the \`file:line\` that disproves it, and plan what is actually true.
2. **Resolve the path.** The date comes from Bun in a named zone, never from the host's ambient one —
   \`date +%F\` gives a different answer on two machines at the same instant, and this app formats no
   date without an explicit IANA time zone.

   \`\`\`sh
   bun -e "console.log(new Intl.DateTimeFormat('en-CA', { timeZone: 'Etc/UTC' }).format(new Date()))"
   \`\`\`

   Then \`docs/plans/<YYYY-MM-DD>-<slug>.md\`. Slug is kebab-case, five words maximum. One file — a
   plan split across a directory is a plan nobody reads to the end.
3. **Write it.** Sections, in this order:

\`\`\`markdown
# <Title>

## Goal
One or two sentences: what, and why.

## Primitive
Which of the eight (\`entity · policy · action · mutator · query · job · route · task\`) and which
slice it lives in. If it fits none, the design is wrong — say so here instead of planning a ninth.

## Files to change
- \`path:line\` — what changes, and why.

## Steps
1. Ordered, concrete. Name the \`x g\` invocation where one applies. Point at code, do not paste it.

## Tests
- What to add, next to the source as \`<file>.test.ts\`. Command to run it.

## Done when
- Acceptance criteria, ending in \`x verify\` green.

## Risks
- Anything the executor must decide, and every claim in the ask the code disproves.
\`\`\`

## Rules

- Fragments over sentences. \`file:line\` refs over prose. Tables for anything with three or more rows.
- Reference-only: point at the code, never re-explain it.
- No checkboxes. The plan is a map, not a tracker.
- The plan must obey the app's own rules — one way to do each thing, generators over hand-written
  files, imports that never cross a surface boundary, a stable error code with a runnable \`fix:\` for
  every new failure, and \`x verify\` green as the last line of *Done when*.

## Output

\`\`\`
✓ docs/plans/<YYYY-MM-DD>-<slug>.md
Next: run it, or /feature it.
\`\`\`
`;

const verify = (): string => `---
description: Run the gate and fix everything it reports.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /verify

Run \`x verify\`.

Green: say so and stop.

Red: fix every finding, then re-run until green. Each finding carries a stable code, a cause and an
executable \`fix:\` — **run the \`fix:\` verbatim before improvising**, and use \`x errors explain <CODE>\`
when the cause is not enough. \`x verify --json\` gives the same steps machine-readably; \`x doctor\`
covers the case where the environment, not the code, is what is broken.

Do not narrow the gate to make it pass. There is no \`--only\` and no \`--skip\`; disabling a lint rule,
loosening a compiler flag, or deleting an assertion is the same evasion. Fix the code.

Report one line per fix: the code, the file, what changed.
`;

/** The three workflows, in the order a new app meets them. */
export function claudeCommandFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: '.claude/commands/feature.md', contents: feature(app) },
    { path: '.claude/commands/planx.md', contents: planx(app) },
    { path: '.claude/commands/verify.md', contents: verify() },
  ];
}
