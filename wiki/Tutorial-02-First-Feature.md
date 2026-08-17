# Tutorial 2 — your first feature

Scaffold the slice, register it, migrate it, name the tests. One `action` declaration becomes an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and three contract assertions — with no second file to keep in step.

`As of 2026-08`. Every command and every output on this page was executed against a `create-ultimate@1.1.0 --no-example` app.

Series: [1 — first app](Tutorial-01-First-App) · **2** · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## Never hand-write a primitive

```bash
bunx x g resource todo --dry-run
```

```text
  + apps/web/app/todo/entity.ts          + apps/web/app/todo/entity.test.ts
  + apps/web/app/todo/repo.ts
  + apps/web/app/todo/policy.ts          + apps/web/app/todo/policy.test.ts
  + apps/web/app/todo/actions/create-todo.ts   + …/create-todo.test.ts
  + apps/web/app/todo/errors.ts
  + apps/web/app/todo/actions/archive-todo.ts  + …/archive-todo.test.ts
  + apps/web/app/todo/live/todo-list.ts        + …/todo-list.test.ts
  + apps/web/app/todo/jobs/reindex-todo.ts     + …/reindex-todo.test.ts
  + apps/web/app/todo/service.ts               + …/service.test.ts
  + apps/web/app/todo/ui.tsx  ui.module.scss  ui/todo-card.tsx  ui/todo-form.tsx
  + packages/i18n/catalogs/en.json
  + apps/web/app/todos/page.tsx  page.module.scss  page.test.ts  page.e2e.test.ts
✓ wrote 25 file(s) for resource todo
```

Drop `--dry-run` to write them. `x g` never clobbers — an existing file is `X_GENERATE_CONFLICT`; the i18n catalog is merged key-by-key rather than overwritten; and a **slice module** (`entity.ts`, `repo.ts`, `policy.ts`, `errors.ts`) the slice already has is skipped, `--force` included, because it belongs to the slice rather than to the generator that needed it. **A run whose catalog merge gains no key writes 24**: a merge that changes nothing is skipped rather than counted.

**No migration is in that list.** `x db gen` is the only writer of `packages/db/migrations`, so a new slice is `x g resource todo` and then the two steps below.

| Generator | Emits |
|---|---|
| `x g resource <n>` | the whole slice above — 25 files, 27 with `--admin --live` |
| `x g entity` / `policy` / `action` / `mutator` / `query` / `job` / `task` | that primitive plus its test — **and the slice modules its own source imports**, when the slice has none: `x g job` is 5 files into a bare slice, `x g action` 8. Which ones differ per generator, so a job plants no `policy.ts` ([CLI reference § x g](CLI-Reference)) |
| `x g route <path> --surface site\|app` | `page.tsx`, its stylesheet, its test, its catalog keys |

`--surface site` on a `resource` is refused: a slice ships a live query and a form with a signal, and `site/` is the never-hydrated surface. Full flag table: [CLI reference § x g](CLI-Reference).

## The layer rule

The slice enforces one call direction, and `x verify`'s `boundaries` step is what makes it real.

| Layer | File | May call |
|---|---|---|
| route | `apps/web/app/todos/page.tsx` | actions, queries |
| action / query | `actions/*.ts`, `live/*.ts` | services |
| service | `service.ts` | the repo |
| repo | `repo.ts` | `db()` — the **only** module that may touch the table |

## The entity

```ts
export const todo = entity('todos', {
  // Naming the tenant column is what turns tenancy on: a read with no org predicate then fails
  // with X_TENANCY_UNSCOPED instead of leaking another org's rows.
  tenant: 'orgId',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text({ max: 200 }),
    price: money(),              // two physical columns: price_minor bigint + price_currency char(3)
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [
    invariant('todo_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('todo_price_non_negative', c.price.minor.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'createdAt'] }],
});
```

`c` is typed from the `columns` above it, so `c.titel` is a compile error naming `title` — see [tutorial 1](Tutorial-01-First-App#the-invariant-block-is-typed-from-your-columns).

Each invariant runs twice from one declaration — in the app on every write, and as a Postgres `CHECK` in the migration. Details: [Entities and migrations](Entities-And-Migrations).

## The policy decides once, everywhere

```ts
export const canTodoWrite = can<TodoScope>(
  'todo:write',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);
```

`can()` checks the grant first and the predicate second, so a denial distinguishes *you may never do this* from *you may, but not in that org*. The generated `policy.test.ts` pins the second gate with an actor who **holds** the grant and is still denied — delete the predicate and that test fails.

Full model: [Policies and authz](Policies-And-Authz).

## The action, and what it projects

```ts
export const createTodo = action({
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: canTodoWrite,
  cache: { invalidates: [todoTag] },
  mcp: { expose: true, description: 'create-todo — generated, edit the description' },
  async handle({ input }) { … },
});
```

`orgId` is in the input because the policy decides on it — authz reads the declaration, never the database.

Five artifacts, read off the real registry with `createTodo.describe()`, `.openapi()`, `.tool()`, `.job()` and `.contract()`:

| Projection | Value, verbatim |
|---|---|
| HTTP route | `POST /api/todos/create`, capability `todo:write` |
| OpenAPI operation | `operationId: "createTodo"`, `summary` from `mcp.description` |
| MCP tool | `createTodo` — the export name verbatim, which is what `tools/call` spells — and `tool().policy === createTodo.policy` is `true`, one authz object, not a copy |
| Job handle | `action:createTodo` — the same handler, run through the queue |
| Contract tests | 3 generated assertions: garbage input rejected, anonymous denied, operation present in the spec |
| Typed client | `.client({ baseUrl })` derives the path by string math, so the browser imports no server code |

```bash
bunx x actions list
```

```text
  name         verb     resource  path                 capability  mcp
  archiveTodo  archive  todos     /api/todos/archive   todo:write  yes
  createTodo   create   todos     /api/todos/create    todo:write  yes
  health       invoke   healths   /api/healths/invoke  public      yes
```

Rename `orgId` in the declaration and every consumer fails typecheck. One rename, N errors, all real work. Every field: [Actions](Actions).

## Register it — the scaffold does not

`x new` writes no `apps/web/api/index.ts`. Without one, jobs and tasks register as `anonymous-job-2` and `anonymous-task-1`, because export names are what name a primitive.

```ts
// apps/web/api/index.ts — importing this module IS the boot
import { defineApi } from '@ultimat3/action';
import * as archiveTodo from '../app/todo/actions/archive-todo';
import * as createTodo from '../app/todo/actions/create-todo';
import * as reindexTodo from '../app/todo/jobs/reindex-todo';
import * as todoList from '../app/todo/live/todo-list';
import * as health from './health';

export const api = defineApi({
  actions: [health, createTodo, archiveTodo],
  queries: [todoList],
  jobs: [reindexTodo],
});

export type Api = typeof api;
```

Import each primitive **file**, not the `actions/` directory — the generator writes no `index.ts` in it. Two features exporting one name collide here with `X_ACTION_DUPLICATE` rather than merging in silence.

## Migrations

`x g resource` writes no migration and does not touch the entity export list. Two steps.

**1. Export the entity.** `packages/db/src/schema.ts` is what the migration generator reads:

```ts
export { todo } from '@myapp/web/app/todo/entity';
```

Now `x verify` sees drift, which is the point:

```text
  ✗ drift              2ms
      X_DB_DRIFT (packages/db/src)
        cause: schema hashes to 92b6e21a9f3acc81, newest migration 20260817120000_initial.hash recorded 164f6d3add24dcd0
        fix:   x db gen "describe the change"
```

A migration id is `<stamp>_<slug>` — the stamp is `x db gen`'s own clock, so yours differs. The one it names here is the `initial` from [tutorial 1](Tutorial-01-First-App#the-database-first-run); `x new` writes no migration, so on `main` that generate has already happened by the time you read this.

**2. `x db gen` does not work at 1.1.0.** It shells out to `drizzle-kit`, which a scaffolded app neither installs nor configures:

```text
  X_DB_GEN_FAILED
    cause: bunx drizzle-kit generate --name add_todos exited 1: No config path provided, using
           default 'drizzle.config.json' … file does not exist
```

`x db migrate` fails identically.

**Fixed on `main`, unreleased.** `x db gen "add todos"` now calls `@ultimat3/db`'s own
`generateMigration()` and writes the three files itself — `<id>.sql`, `<id>.snapshot.json` and
`<id>.hash` — while `x db migrate` runs the same migrator `ROLE=migrate` runs. Skip the script
below on `main`; on 1.1.0 it is the way through. `@ultimat3/db` exports the framework's own
generator, so a twenty-line script does the job — this one passes `x verify`:

```ts
// scripts/db-gen.ts —  bun run scripts/db-gen.ts 0001 "add todos"
import { join } from 'node:path';
import { writeSchemaHash } from '@ultimat3/cli';
import { generateMigration, slugify } from '@ultimat3/db';
import * as schema from '../packages/db/src/schema';

const root = join(import.meta.dir, '..');
const ordinal = Bun.argv[2] ?? '0001';
const name = Bun.argv[3] ?? 'change';

const entities = Object.values(schema).map((entity) => entity.$describe());
const migration = generateMigration({ entities, name });
const id = `${ordinal}_${slugify(name)}`;

await Bun.write(
  join(root, 'packages/db/migrations', `${id}.sql`),
  `${migration.up}\n\n-- down\n${migration.down}\n`,
);
const hash = await writeSchemaHash(root, id);
await Bun.stdout.write(`${JSON.stringify({ ok: true, id, hash })}\n`);
```

```text
{"ok":true,"id":"0001_add_todos","hash":"92b6e21a9f3acc81"}
```

Two edits to the emitted SQL, both mechanical:

| Emitted | Why it fails | Fix |
|---|---|---|
| `create index "todos_org_id_created_at_idx" on "todos" ("org_id_created_at");` | the composite index column list round-trips as one mangled name. **Fixed on `main`, unreleased** — on 1.1.0 it is an edit | spell the columns: `("org_id", "created_at")` |
| `create table …;` and `create index …;` in one file | the driver ran a migration's `up` as one prepared statement — *cannot insert multiple commands into a prepared statement*, on the embedded database always. **Fixed on `main`, unreleased** — the script is split and sent one statement at a time, in one transaction | on 1.2.0, **one statement per migration file**; split into `0001_…` and `0002_…`, each with its own `.hash` |

Apply them the way production does — same code path, no toolchain:

```bash
ROLE=migrate bun apps/web/server.ts
```

On `main`, `bunx x db migrate` is that same code path with a `--json` report and a drift check
after it. Both read `packages/db/migrations` and write one `x_migrations` ledger.

```text
{"ts":"2026-08-11T17:09:15.790Z","level":"info","msg":"ultimate migrate applied","applied":3,"available":3,"appVersion":"dev"}
```

The `.hash` sidecar beside each migration is what `drift` compares against, so a fresh clone detects drift with no database and no local state.

## Name the tests after their step

A test's type is its **filename suffix**, not the helper it calls. `contractTest()` inside `create-todo.test.ts` runs under `unit`, and `x test contract` reports `X_TEST_NO_FILES`.

| Rename | Moves into step |
|---|---|
| `create-todo.test.ts` → `create-todo.contract.test.ts` | `contract` |
| `live/todo-list.test.ts` → `live/todo-list.live.test.ts` | `live` |
| `jobs/reindex-todo.test.ts` → `jobs/reindex-todo.job.test.ts` | `job` |
| `*.e2e.test.ts`, anything under `e2e/` | `e2e` |
| `*.eval.test.ts` | `eval` |

## The gate, green

```bash
bunx x verify
```

```text
  ✓ typecheck          10026ms      ✓ contract           234ms
  ✓ lint               179ms        ✓ live               167ms
  ✓ boundaries         12ms         ✓ job                128ms
  ✓ filesize           10ms         - e2e                0ms
  ✓ package-shape      2ms          ✓ eval               97ms
  ✓ errors             18ms         ✓ drift              2ms
  ✓ unit               277ms        - contract-diff      0ms
                                    ✓ budgets            0ms
                                    ✓ manifest           1ms
                                    - roadmap            0ms
✓ 14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap
```

Three steps that were dashes in [tutorial 1](Tutorial-01-First-App) are now ticks, from renaming three files — and the summary names the three that still have nothing to run.

## Drive it from an agent

```bash
bunx x mcp serve --transport http --port 9229
```

13 framework tools, one catalog, the same on `stdio` and `http` — `routes.list`, `schema.describe`, `policies.list`, `actions.describe`, `jobs.inspect`, `queue.depth`, `manifest.read`, `errors.explain`, `db.query`, `db.migrate`, `tests.run`, `verify.run`, `logs.tail`. `bunx x mcp tools` prints them with their scopes.

`createTodo` reaches an agent's tool list through the app's own surface in `packages/mcp/src/index.ts` (`defineAppMcp({ include: 'exposed' })`), carrying `mcp: { expose: true }` and **the action's own policy** as its authorization. Full model: [MCP and AI](MCP-And-AI).

## Next

[Tutorial 3 — auth and admin](Tutorial-03-Auth-And-Admin): who the actor is, which roles grant which permissions, and the admin surface over the actions you just declared.

Related: [Actions](Actions) · [Entities and migrations](Entities-And-Migrations) · [Testing](Testing) · [Known gaps](Known-Gaps)
