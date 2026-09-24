# Tutorial 2 — your first feature

Scaffold the slice, register it, migrate it, name the tests. One `action` declaration becomes an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and three contract assertions — with no second file to keep in step.

`As of 2026-08`. Every command and every output on this page was executed against a `create-ultimate@1.1.0 --no-example` app, and has not been re-run on `main`. Step 2's migration workaround was removed on 2026-09-23: `x db gen` has worked since 2.0.0.

Series: [1 — first app](Tutorial-01-First-App) · **2** · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## Never hand-write a primitive

```bash
bunx x g resource todo --dry-run
```

```text
  + apps/web/app/todo/entity.ts
  + apps/web/app/todo/entity.test.ts
  + apps/web/app/todo/repo.ts
  + apps/web/app/todo/policy.ts
  + apps/web/app/todo/policy.test.ts
  + apps/web/app/todo/errors.ts
  + apps/web/app/todo/actions/create-todo.ts
  + apps/web/app/todo/actions/create-todo.test.ts
  + apps/web/app/todo/actions/create-todo.contract.test.ts
  + apps/web/app/todo/actions/archive-todo.ts
  + apps/web/app/todo/actions/archive-todo.test.ts
  + apps/web/app/todo/actions/archive-todo.contract.test.ts
  + apps/web/app/todo/live/todo-list.ts
  + apps/web/app/todo/live/todo-list.live.test.ts
  + apps/web/app/todo/jobs/reindex-todo.ts
  + apps/web/app/todo/jobs/reindex-todo.job.test.ts
  + apps/web/app/todo/service.ts
  + apps/web/app/todo/service.test.ts
  + apps/web/app/todo/ui.tsx
  + apps/web/app/todo/ui.module.scss
  + apps/web/app/todo/ui/todo-card.tsx
  + apps/web/app/todo/todo-form.island.tsx
  + apps/web/app/todo/todo-form.island.test.ts
  + packages/i18n/catalogs/en.json
  + apps/web/app/todos/page.tsx
  + apps/web/app/todos/page.module.scss
  + apps/web/app/todos/page.test.ts
  + apps/web/app/todos/page.e2e.test.ts
✓ would write 29 file(s) for resource todo — nothing written
```

**The form is an island, not a `ui/` component** — `todo-form.island.tsx` beside the slice rather than under `ui/`. A `createSignal` needs the browser, `.island.tsx` is what puts a module in the client bundle graph, and the route's `budget.js` is what bounds it. Everything under `ui/` renders on the server and ships no JS.

Drop `--dry-run` to write them. `x g` never clobbers — an existing file is `X_GENERATE_CONFLICT`; the i18n catalog is merged key-by-key rather than overwritten; and a **slice module** (`entity.ts`, `repo.ts`, `policy.ts`, `errors.ts`) the slice already has is skipped, `--force` included, because it belongs to the slice rather than to the generator that needed it. **A `resource` run whose catalog merge gains no key writes 27**: a merge that changes nothing is skipped rather than counted, and the catalog is the one mergeable file in the list.

**No migration is in that list.** `x db gen` is the only writer of `packages/db/migrations`, so a new slice is `x g resource todo` and then the two steps below.

| Generator | Emits |
|---|---|
| `x g resource <n>` | the whole slice above — 29 files, 31 with `--admin` |
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

`canTodoCreate` is the same grant with the one tenancy rule a create can have — the actor **has** an org — because the row is written under the actor's org, never one named in the body.

The generator also **grants** what it declares, in `apps/web/shared/roles.ts`: `todo:read` to `member`, `todo:write` to `admin` (the dev actor's role). A permission an action requires and no role grants is `X_PERMISSION_UNGRANTED` on `x verify`'s `policy` step — every request to it would answer 403.

Full model: [Policies and authz](Policies-And-Authz).

## The action, and what it projects

```ts
export const CreateTodoInput = todo.$view(['title', 'price']);

export const createTodo = action({
  input: CreateTodoInput,
  output: TodoView,
  policy: canTodoCreate,
  cache: { invalidates: [todoTag] },
  // No `mcp` until you write a real description: an agent reads it to decide to call the tool.
  async handle({ input, ctx }) { … return service.create({ ...input, orgId }); },
});
```

A real insert. The input is the entity's own view of the columns a caller supplies, so a column added to `entity.ts` is one edit to that list; `orgId` comes from `ctx.actor`, never from the body.

```bash
curl -X POST localhost:3000/api/todos/create -H 'content-type: application/json' \
  -H 'sec-fetch-site: same-origin' -d '{"title":"Ship it","price":{"minor":1250,"currency":"USD"}}'
```

Five artifacts, read off the real registry with `createTodo.describe()`, `.openapi()`, `.tool()`, `.job()` and `.contract()`:

| Projection | Value, verbatim |
|---|---|
| HTTP route | `POST /api/todos/create`, capability `todo:write` |
| OpenAPI operation | `operationId: "createTodo"`, `summary` from `mcp.description` |
| MCP tool | none until `mcp: { expose: true, description }` is written; then `createTodo` — the export name verbatim — and `tool().policy === createTodo.policy`, one authz object, not a copy |
| Job handle | `action:createTodo` — the same handler, run through the queue |
| Contract tests | 3 generated assertions: garbage input rejected, anonymous denied, operation present in the spec |
| Typed client | `.client({ baseUrl })` derives the path by string math, so the browser imports no server code |

```bash
bunx x actions list
```

```text
  name         verb     resource  path                 capability  mcp
  archiveTodo  archive  todos     /api/todos/archive   todo:write  no
  createTodo   create   todos     /api/todos/create    todo:write  no
  health       invoke   healths   /api/healths/invoke  public      yes
```

Rename a column in the entity and every consumer fails typecheck. One rename, N errors, all real work. Every field: [Actions](Actions).

## Registered for you

`x new` writes `apps/web/api/index.ts`, and `x g resource`, `x g job` and `x g task` add their jobs and tasks to it. A job no `defineApi` lists keeps the positional name `job()` gave it — `anonymous-job-2` — and `x verify`'s `manifest` step refuses that as `X_JOB_UNREGISTERED`. After `x g resource todo`:

```ts
// apps/web/api/index.ts, in an app made with `x new --no-example` — importing it IS the boot
import { defineApi } from '@ultimat3/action';
import * as reindexTodo from '../app/todo/jobs/reindex-todo';
import * as health from './health';

export const api = defineApi({
  actions: [health],
  jobs: [reindexTodo],
});
```

Only jobs and tasks are added: the module scan registers actions and queries by export name on its own, and registers no job. Listing an action here too is allowed — `x new`'s example slice does — and each primitive is imported as a **file**, never a directory. Two features exporting one name collide with `X_ACTION_DUPLICATE` rather than merging in silence.

## Migrations

`x g resource` writes no migration and does not touch the entity export list. Two steps.

**1. Export the entity.** `packages/db/src/schema.ts` is the db package's public surface — what the
rest of the app imports a `todo` from:

```ts
export { todo } from '@myapp/web/app/todo/entity';
```

It is **not** what the migration generator reads. `x db gen` diffs the entity **registry**
(`describeEntities()`), and `x verify`'s `drift` step hashes that same registry alongside the text
under `packages/db/src/**` — so the entity is already in the diff the moment its own file exists.
`loadApp` imports every module under `apps/*/{site,app,api,shared}/**` and `packages/*/src/**`, and
`entity()` registers on import. `examples/dummy` is the proof: it has entities, migrations and a
green `drift` step, and no `packages/db/src/schema.ts` at all.
Adding the export line moves the text half of the hash too, which is why the drift below is the same
either way:

```text
  ✗ drift              2ms
      X_DB_DRIFT (packages/db/src)
        cause: schema hashes to 92b6e21a9f3acc81, newest migration 20260817120000_initial.hash recorded 164f6d3add24dcd0
        fix:   x db gen "describe the change"
```

A migration id is `<stamp>_<slug>` — the stamp is `x db gen`'s own clock, so yours differs. The one it names here is the `initial` from [tutorial 1](Tutorial-01-First-App#the-database-first-run); `x new` writes no migration, so on `main` that generate has already happened by the time you read this.

**2. Generate the migration.** `x db gen` diffs the entity registry against the newest
migration's snapshot and writes three files — `<id>.sql`, `<id>.snapshot.json` and `<id>.hash`:

```bash
bunx x db gen "add todos"
```

The 1.1.0 workaround this step used to carry (a hand-written `scripts/db-gen.ts`, and two manual
edits to the emitted SQL) is gone: all three defects it worked around were fixed in 2.0.0, and
`scaffold-smoke` in CI runs `x db gen` then `x db migrate` on a fresh scaffold on every push.

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
✓ 17 of 20 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap
```

Three steps that were dashes in [tutorial 1](Tutorial-01-First-App) are now ticks, from renaming three files — and the summary names the three that still have nothing to run.

## Drive it from an agent

```bash
bunx x mcp serve --transport http --port 9229
```

18 tools, one catalog, the same on `stdio` and `http` — 13 framework tools (`routes.list`, `schema.describe`, `policies.list`, `actions.describe`, `jobs.inspect`, `queue.depth`, `manifest.read`, `errors.explain`, `db.query`, `db.migrate`, `tests.run`, `verify.run`, `logs.tail`) and five that look at the UI (`ui.shot`, `ui.island`, `ui.inspect`, `ui.interact`, `ui.diff`). `bunx x mcp tools` prints them with their scopes.

`createTodo` reaches an agent's tool list through the app's own surface in `packages/mcp/src/index.ts` (`defineAppMcp({ include: 'exposed' })`), carrying `mcp: { expose: true }` and **the action's own policy** as its authorization. Full model: [MCP and AI](MCP-And-AI).

## Next

[Tutorial 3 — auth and admin](Tutorial-03-Auth-And-Admin): who the actor is, which roles grant which permissions, and the admin surface over the actions you just declared.

Related: [Actions](Actions) · [Entities and migrations](Entities-And-Migrations) · [Testing](Testing) · [Known gaps](Known-Gaps)
