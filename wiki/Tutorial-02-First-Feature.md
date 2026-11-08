# Tutorial 2 — your first feature

Scaffold the slice, register it, migrate it, name the tests. One `action` declaration becomes an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and three contract assertions — with no second file to keep in step.

`As of 2026-11-03`. Every command and every output on this page was re-run in the app [tutorial 1](Tutorial-01-First-App) leaves — `bunx create-ultimate myapp`, example slice included, built from this tree's packages (`scripts/scaffold-smoke-overrides.ts`) — by hand, in that order. `scripts/tutorial-run.ts` runs tutorials 1–4 the same way. Timings are that machine's; yours differ.

Series: [1 — first app](Tutorial-01-First-App) · **2** · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## Never hand-write a primitive

```bash
bunx x g resource todo --dry-run
```

```text
  + apps/web/app/todo/entity.ts
  + apps/web/app/todo/entity.test.ts
  + apps/web/app/todo/repo.ts
  + apps/web/app/todo/repo.test.ts
  + apps/web/app/todo/policy.ts
  + apps/web/app/todo/policy.test.ts
  + apps/web/app/todo/actions/create-todo.ts
  + apps/web/app/todo/actions/create-todo.test.ts
  + apps/web/app/todo/actions/create-todo.contract.test.ts
  + apps/web/app/todo/errors.ts
  + apps/web/app/todo/actions/archive-todo.ts
  + apps/web/app/todo/actions/archive-todo.test.ts
  + apps/web/app/todo/actions/archive-todo.contract.test.ts
  + packages/i18n/catalogs/en.json
  + apps/web/app/todo/live/todo-list.ts
  + apps/web/app/todo/live/todo-list.live.test.ts
  + apps/web/app/todo/live/todo-list.test.ts
  + apps/web/app/todo/jobs/reindex-todo.ts
  + apps/web/app/todo/jobs/reindex-todo.job.test.ts
  + apps/web/app/todo/jobs/reindex-todo.test.ts
  + apps/web/app/todo/service.ts
  + apps/web/app/todo/service.test.ts
  + apps/web/app/todo/ui.tsx
  + apps/web/app/todo/ui.test.ts
  + apps/web/app/todo/ui.module.scss
  + apps/web/app/todo/ui/todo-card.tsx
  + apps/web/app/todo/todo-form.island.tsx
  + apps/web/app/todo/todo-form.island.states.ts
  + apps/web/app/todo/todo-form.island.test.ts
  + apps/web/app/todos/page.module.scss
  + apps/web/app/todos/page.e2e.test.ts
  + apps/web/app/todos/page.tsx
  + apps/web/app/todos/page.test.ts
  + apps/web/app/todos/page-db.test.ts
  + apps/web/shared/roles.ts
  + apps/web/api/index.ts
  + packages/db/src/client.ts
✓ would write 38 file(s) for resource todo — nothing written
```

**The form is an island, not a `ui/` component** — `todo-form.island.tsx` beside the slice rather than under `ui/`. A `createSignal` needs the browser, `.island.tsx` is what puts a module in the client bundle graph, and the route's `budget.js` is what bounds it. Everything under `ui/` renders on the server and ships no JS.

Drop `--dry-run` to write them:

```bash
bunx x g resource todo
```

```text
✓ wrote 40 file(s) for resource todo — next: …
```

`x g` never clobbers — an existing file is `X_GENERATE_CONFLICT`; the i18n catalog is merged key-by-key rather than overwritten; and a **slice module** (`entity.ts`, `repo.ts`, `policy.ts`, `errors.ts`) the slice already has is skipped, `--force` included, because it belongs to the slice rather than to the generator that needed it. The last three lines are the wiring: the grants in `roles.ts`, the slice's actions, query and job in `api/index.ts`, and its entity in the db client (`packages/db/src/client.ts`). A file the run would leave unchanged — a catalog merge that gains no key, wiring a previous slice already wrote — is skipped rather than counted. Here `bun run setup` has written `x.manifest.json` and `openapi.json` ([tutorial 1](Tutorial-01-First-App)), so the run re-projects both and prints 39; in an app with neither it prints 37. In a `x new --no-example` app, whose two `package.json`s do not yet name the workspace packages, the same runs print 39 and 41 (42 with `--admin`).

**No migration is in that list.** `x db gen` is the only writer of `packages/db/migrations`, so a new slice is `x g resource todo` and then the two steps below.

| Generator | Emits |
|---|---|
| `x g resource <n>` | the whole slice above — 38 files on a dry run in tutorial 1's app, 41 with `--admin` (`As of 2026-11-08`); a real run after `bun run setup` adds the two re-projected artifacts |
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

<!-- no-run: needs `bunx x dev` serving on :3000 -->
```bash
curl -X POST localhost:3000/api/todos/create -H 'content-type: application/json' \
  -H 'sec-fetch-site: same-origin' -d '{"title":"Ship it","price":{"minor":1250,"currency":"USD"}}'
```

Five artifacts, read off the real registry with `createTodo.describe()`, `.openapi()`, `.job()`, `.contract()` and `@ultimat3/mcp`'s `toolFrom(createTodo)`:

| Projection | Value, verbatim |
|---|---|
| HTTP route | `POST /api/todos/create`, capability `todo:write` |
| OpenAPI operation | `operationId: "createTodo"`, `summary` from `mcp.description` |
| MCP tool | none until `mcp: { expose: true, description }` is written; then `createTodo` — the export name verbatim — and every call goes through `createTodo`'s own `invoke`, so its policy is the one authz object, not a copy |
| Job handle | `action:createTodo` — the same handler, run through the queue |
| Contract tests | 3 generated assertions: garbage input rejected, anonymous denied, operation present in the spec |
| Typed client | `.client({ baseUrl })` derives the path by string math, so the browser imports no server code |

```bash
bunx x actions list
```

```text
  name         verb     resource  path                 capability  mcp
  archivePost  archive  posts     /api/posts/archive   post:write  no
  archiveTodo  archive  todos     /api/todos/archive   todo:write  no
  createPost   create   posts     /api/posts/create    post:write  no
  createTodo   create   todos     /api/todos/create    todo:write  no
  health       invoke   healths   /api/healths/invoke  public      yes
✓ 5 actions
```

`archivePost` and `createPost` are the example `post` slice tutorial 1's app ships with. Rename a column in the entity and every consumer fails typecheck. One rename, N errors, all real work. Every field: [Actions](Actions).

## Registered for you

`x new` writes `apps/web/api/index.ts`, and every `x g` adds the primitives it wrote to it. A job no `defineApi` lists keeps the positional name `job()` gave it — `anonymous-job-2` — and `x verify`'s `manifest` step refuses that as `X_JOB_UNREGISTERED`. After `x g resource todo`:

```ts
// apps/web/api/index.ts, in an app made with `x new --no-example` — importing it IS the boot
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
```

Tutorial 1's app lists its example `post` slice the same way, ahead of the `todo` lines. The jobs are the half an app cannot skip: the module scan registers actions and queries by export name on its own, and registers no job. Actions and queries are listed for the type — `Api` is what the browser's typed client is shaped from. Each primitive is imported as a **file**, never a directory. Two features exporting one name collide with `X_ACTION_DUPLICATE` rather than merging in silence.

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
either way. `bunx x verify --only drift`:

```text
  ✗ drift              2161ms
      X_DB_SCHEMA_UNMIGRATED (packages/db/migrations)
        cause: table "todos" is declared by the entities and no migration recorded it
        fix:   bunx x db gen "record todos"
```

The newest migration is tutorial 1's `initial`, which recorded the example `posts` table; `todos` is
in no migration yet. The slug is yours to choose; the fix only suggests one.

**2. Generate the migration.** `x db gen` diffs the entity registry against the newest
migration's snapshot and writes three files — `<id>.sql`, `<id>.snapshot.json` and `<id>.hash` —
and refreshes the schema dump under `packages/db/schema/` (`todos.sql` under `04_tables/` and
`05_indexes/`). A migration id is `<stamp>_<slug>`; the stamp is `x db gen`'s own clock:

```bash
bunx x db gen "add todos"
```

```text
✓ migration …_add_todos generated
```

The 1.1.0 workaround this step used to carry (a hand-written `db-gen.ts` script, and two manual
edits to the emitted SQL) is gone: all three defects it worked around were fixed in 2.0.0, and
`scaffold-smoke` in CI runs `x db gen` then `x db migrate` on a fresh scaffold on every push.

Apply them the way production does — same code path, no toolchain:

<!-- no-run: the release-phase path; the x db migrate fence below applies the same migrations -->
```bash
ROLE=migrate bun apps/web/server.ts
```

```text
{"ts":"2026-11-03T15:52:26.924Z","level":"info","msg":"ultimate migrate applied","applied":1,"available":1,"appVersion":"dev"}
```

`bunx x db migrate` is that same code path with a drift check after it. Both read
`packages/db/migrations` and write one `x_migrations` ledger:

```bash
bunx x db migrate
```

```text
✓ migrations applied
```

The `.hash` sidecar beside each migration is what `drift` compares against, so a fresh clone detects drift with no database and no local state.

## Name the tests after their step

A test's type is its **filename suffix**, not the helper it calls. `contractTest()` inside `create-todo.test.ts` runs under `unit`, and `x test contract` reports `X_TEST_NO_FILES`. `x g` already writes the typed names — `create-todo.contract.test.ts`, `todo-list.live.test.ts`, `reindex-todo.job.test.ts`, `page.e2e.test.ts` in the list above — so this is the rule for a test you add by hand:

| Suffix | Runs in step |
|---|---|
| `*.contract.test.ts` | `contract` |
| `*.live.test.ts` | `live` |
| `*.job.test.ts` | `job` |
| `*.e2e.test.ts`, anything under `e2e/` | `e2e` |
| `*.eval.test.ts` | `eval` |

## The gate, green

```bash
bunx x verify
```

Timings, worker counts and the `slowest:` lines trimmed:

```text
  ✓ typecheck
  ✓ lint
  ✓ boundaries
  ✓ filesize
  ✓ package-shape
  ✓ errors
  ✓ unit
  ✓ contract
  ✓ live
  ✓ job
  ✓ exercise
  ✓ e2e
  ✓ eval
  ✓ drift
  ✓ contract-diff
  ✓ budgets
  ✓ seo
  ✓ i18n
  ✓ policy
  ✓ manifest
  - roadmap
✓ 20 of 21 steps passed in …ms — 1 skipped: roadmap
```

`live`, `job` and `e2e` were dashes in [tutorial 1](Tutorial-01-First-App); the slice's own typed tests are what they now run. `budgets` builds the site first when no current measurement exists, so it is green on the first run. `e2e` drives a real Chrome; on a machine without one its browser cases skip (`E2E_BROWSER_REQUIRED=1` makes that a refusal). `roadmap` reads `docs/idea/14-roadmap.md`, which an app does not have.

## Drive it from an agent

<!-- no-run: a server that runs until stopped -->
```bash
bunx x mcp serve --transport http --port 9229
```

19 tools, one catalog, the same on `stdio` and `http` — 14 framework tools (`routes.list`, `schema.describe`, `policies.list`, `actions.describe`, `jobs.inspect`, `queue.depth`, `manifest.read`, `errors.explain`, `db.query`, `db.migrate`, `tests.run`, `verify.run`, `logs.tail`, `graph.query`) and five that look at the UI (`ui.shot`, `ui.island`, `ui.inspect`, `ui.interact`, `ui.diff`). `bunx x mcp tools` prints them with their scopes.

`createTodo` reaches an agent's tool list through the app's own surface in `packages/mcp/src/index.ts` (`defineAppMcp({ include: 'exposed' })`), carrying `mcp: { expose: true }` and **the action's own policy** as its authorization. Full model: [MCP and AI](MCP-And-AI).

## Next

[Tutorial 3 — auth and admin](Tutorial-03-Auth-And-Admin): who the actor is, which roles grant which permissions, and the admin surface over the actions you just declared.

Related: [Actions](Actions) · [Entities and migrations](Entities-And-Migrations) · [Testing](Testing) · [Known gaps](Known-Gaps)
