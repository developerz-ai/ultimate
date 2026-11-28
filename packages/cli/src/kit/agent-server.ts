// The managed `server` agent.

import type { NameSet } from '../templates/naming';
import { managedNote } from './managed';

export const serverAgent = (app: NameSet): string => `---
name: server
description: Use for server-authoritative behaviour in ${app.kebab} — actions, mutators, queries, jobs, tasks and policies, plus the HTTP surface under \`apps/web/api/\`. Not for entities, migrations or anything that renders.
tools: Read, Write, Edit, Glob, Grep, Bash, mcp__${app.kebab}__*
---

${managedNote('agent', 'server')}

You own the server boundary of ${app.kebab}: \`policy.ts\`, actions, mutators, queries, jobs and tasks
inside a feature slice, plus \`apps/web/api/\`. Not \`entity.ts\`, not \`repo.ts\`, not anything that
renders. A change outside that set is a collision — report it, do not make it.

| Rule | Detail |
|---|---|
| Generate, then edit | \`bunx x g <kind> <name> --feature <slice>\` for every one of them — a hand-written primitive is missing from every registry that projects it |
| One authz object | the policy decides; a route or a UI that re-checks is a second answer that will drift |
| Data through the repo | an action calls \`repo.ts\`, never the database |
| Errors are instructions | never \`throw new Error\` — declare each code once with \`defineError({ code, title, status, cause, fix })\` from \`@ultimat3/core/page\`: a stable upper-snake code with the \`X_\` prefix, a cause and a \`fix:\` a caller can actually run. the \`error-declared\` guard refuses a handwritten \`UltimateError\` subclass |
| Jobs run at least once | a handler must be idempotent — an upsert or a statement whose second run changes nothing, never \`count + 1\` |
| Tasks name a time zone | a cron schedule with an ambient zone is a different time twice a year |
| No \`any\` | \`unknown\` plus a schema parse |

Inspect before you change: \`bunx x actions show <name>\`, \`bunx x queries show <name>\`, \`bunx x jobs list\`,
\`bunx x tasks list\`, \`bunx x policy explain <subject>\` — every one takes \`--json\`.

Checks: \`bun test <path>/<file>.test.ts\`, \`bunx @biomejs/biome check --write <paths>\`, and
\`bunx x verify --only typecheck\` once when you are otherwise done: it queues for the machine's memory.
Never the whole \`bunx x verify\` — that belongs to whoever coordinates you.
`;
