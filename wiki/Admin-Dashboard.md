# Admin dashboard

One declaration serves it. `defineAdmin({ entities, db })` is a list, a detail and a form for every entity at `/admin/<entity>` — the app writes no page, no screen glue and no repo adapter. `As of 2026-10`.

```ts
// apps/admin/app/admin/admin.ts — the whole dashboard
import { db } from '@app/db';
import { adminEntitiesOf, defineAdmin } from '@ultimat3/admin';

export const admin = defineAdmin({ entities: adminEntitiesOf(db), db });
```

| Input | Default | Override |
|---|---|---|
| `entities` | required — `adminEntitiesOf(db)` is "every entity the handle serves" | name them: `entities: [posts, users]` |
| `db` | the app's `database()` handle; each resource reads through its own table — tenancy, soft delete and sealing are the handle's | `resources: { <entity>: { repo } }` for one resource. Neither is `X_ADMIN_REPO_UNBOUND` at declaration |
| `auth.actor` | the actor the HTTP pipeline resolved for the request | `auth: { actor: (request) => … }` |
| `auth.authz` | `roleAuthz()` — the role map decides each permission by name, so the admin is closed until a role grants `admin:read` and `<entity>:read` | `policyAuthz({ policies })` for row- or tenant-reading rules; `singlePolicyAuthz(policy)` when one grant runs the whole admin |
| `resources.<entity>` | derived: list columns, filters, sorts, label | `listFields`, `labelField`, `columns`, `scopes`, `rows`, `fields.<name>.sensitive`, `permission` (the noun `<noun>:read\|write\|delete` is named after; default the entity's name) |
| `basePath` | `/admin` | `basePath: '/back-office'` |

`x dev` and the container mount every admin the app declared: one catch-all under its base path, `GET` and `POST`. `x new` scaffolds the declaration; `x g entity` adds an entity to the handle and it is a screen on the next boot.

| URL | Screen | Write it accepts |
|---|---|---|
| `/admin` | dashboard: each resource the actor may open, with the permission pair behind every operation | `POST` an app-wide action |
| `/admin/<entity>` | list — scope tabs, a filter bar, the batch bar, sort headers and a keyset pager, all links and native forms (`?scope=`, `?f.<field>=`, `?sort=<field>:<dir>`, `?cursor=`) | `POST _operation=batch` (`name`, `selection=checked\|all`, `ids`) |
| `/admin/<entity>/lookup?term=` | the picker every filter and input referencing the entity searches: `contains` on its label, keyset-paged | — |
| `/admin/<entity>/new` | create form | `POST` → 303 to the row, or 422 with the issues |
| `/admin/<entity>/<id>` | detail: sections, related lists, row actions, history (`?history=` pages older) | `POST _operation=action` (`input.<field>`) · `_operation=delete` (needs `confirmation`) |
| `/admin/<entity>/<id>?action=<name>` | an action's own form, when it declares an `input` schema | posts at the row |
| `/admin/<entity>/<id>/edit` | edit form | `POST` → 303 to the row, or 422 |
| `/admin/search?term=` · `/admin/audit` | built-in screens | — |
| `/admin/jobs` · `/admin/jobs/runs` · `/queues` · `/tasks` · `/workers` | the jobs dashboard every admin carries — [below](#the-jobs-dashboard) | row actions and the batch bar, as any resource |
| `/admin/<page path>` | a `pages:` entry | — |

A refusal is a 403 document naming the permission, and an audit entry. Anonymous is the pipeline's own 401 (or the app's sign-in redirect). Every admin document is `noindex, nofollow` and carries no `og:*` / `twitter:*` tag. A row action lands on its row (303); a batch answers a page of counts (200).

## The list

`As of 2026-10`. Everything on a list page is derived from the entity or declared once on the resource.

| On the page | Source | Notes |
|---|---|---|
| Filter bar | one control per derived filter: text → `contains`, enum → a select of the entity's own values, boolean, number/date/timestamp → a from–to range, reference → a picker | the label field is always first — it is the list's search box. Money, JSON, sealed and tenant columns are never filters |
| Scope tabs | `scopes: { open: { where, default?, count? } }` | at most one `default`; a count is read only for a scope that sets `count: true` |
| Reference cells | the TARGET resource's `labelField`, linked to the row | one read per referenced resource per page, never one per row |
| Computed columns | `columns: { age: { value, render } }` | `render`: `badge`, `relative-time`, `money`, `truncate`, `link`, `json`, or a component |
| Row scope | `rows: (actor) => AdminFilter[]` | applied by the list, the search, the detail read, the lookup, the labels and the MCP tools — one declaration, no second copy of the resource for a second audience |

| URL parameter | Means |
|---|---|
| `?f.<field>=<value>` | the field's default operator (`contains` for text, `eq` otherwise) |
| `?f.<field>.<op>=<value>` | `eq` `neq` `contains` `gt` `gte` `lt` `lte` `in` (repeat the parameter) `is-null` (`true` / `false`) — the ones the field's shape answers |
| `?scope=<name>` | a declared scope; absent is the default |
| `?sort=<field>:<asc\|desc>` | a sortable field |
| `?cursor=<signed>` | keyset position |

An unknown field, operator, sort, scope or parameter — or a value that is not the column's type — is `X_ADMIN_FILTER_INVALID`: a 400 naming what the list answers, never the unfiltered list. The MCP list tool takes the same grammar (`scope`, `where: [{ field, op?, value }]`).

Statements per list page: 1 for the rows, 1 per counted scope, 1 per referenced resource (2 for one with more than 50 rows that a control picks from). A reference picker is a `<select>` up to 50 rows and the target's lookup screen above that — both work with scripting off.

## Detail, form, actions

`As of 2026-10`.

| Declared on the resource | Rule |
|---|---|
| `sections: [{ titleKey, fields }]` | titled groups on the detail; a field named in none falls into a default section drawn last — adding a column never hides it |
| `formGroups: [{ titleKey, fields }]` | the same for create and edit |
| `related: ['comments']` | a `hasMany` of the entity, drawn as the related resource's OWN list — its columns, its `rows`, its policy — filtered to this row. A resource the actor may not list is left out |
| `fields.<name>.hintKey` · `.on: 'create' \| 'update'` | the line under the control; a field that exists on one side only, enforced on the write too |

| Declared on an action | Rule |
|---|---|
| `input: t.object({ … })` | the button is a link to the action's form; a refusal is a 422 with each issue on its field. No schema: a confirm only |
| `when: (row) => boolean` | decides the button on the detail and each list row, and is asked again before the handler: `X_ADMIN_ACTION_NOT_APPLICABLE` (409) |
| `batch: true` | in the list's batch bar: checked rows, or every row the list's URL matches (200 per request, continued from where it stopped). Each row through the button's gate and on the audit log; answered `done` / `refused` / `failed` / `remaining` |
| `batch: { threshold, chunk? }` | past `threshold` rows, one `admin.batch` job per chunk, run by a worker as the operator; `queued` in the answer |
| `matching: ({ where, input, ctx }) => { affected, remaining }` | "all matching" as ONE set-based call over the list's `where` (row scope, scope, filters) — a store's bounded bulk verb — decided and audited once; a destructive one types `<entity>:all matching`. Checked rows still run row by row |

Still one MCP tool per action — a batch action's takes `ids`. No script on any of it: the row checkboxes join the bar's form by their `form` attribute, and a confirmation is a server round trip. An action's input fields are labelled `admin.input.<action>.<field>` — beside its own `admin.action.<action>`, never under it, so both fit one JSON catalog. An action on a row the actor cannot see (gone, or outside its `rows`) is refused, `when` or none.

A create, or an update of the fields it touches, whose resulting row falls outside the actor's `rows(actor)` is refused before the repo is called — audited as a denial, reason `admin.error.row-out-of-scope`, on the screens and over MCP alike.

## The audit log

`As of 2026-10`. `defineAdmin({ audit })` takes one `AuditLog`; the default is `memoryAuditLog()`.

| Store | Keeps | Use |
|---|---|---|
| `memoryAuditLog()` | this process's entries, until a restart | tests, `x dev` |
| `postgresAuditLog()` | `x_admin_audit` — applied at boot with every framework table, from `@ultimat3/admin/schema`; one insert per audited write, inside the write's own transaction (`AuditLog.atomic`) | production: `audit: Bun.env['DATABASE_URL'] ? postgresAuditLog() : memoryAuditLog()` |
| your own `AuditLog` | anything with `append`, `entries(query)` (async), `atomic(run)` and `kind` | — |

| Rule | Detail |
|---|---|
| What is recorded | every write and every refusal. An allowed read (`list`, `detail`, `search`, a page) is stored by `postgresAuditLog({ reads: true })` only |
| Redaction | a `sensitive` or sealed value is only ever `[redacted]`, in the diff and on screen |
| Where it shows | the detail page's history card — `audit.entries({ entity, entityId, changes: true })`, keyset by `?history=`; `/admin/audit` (`audit:read`) for the whole trail |
| A copy elsewhere | `memoryAuditLog({ sinks })` / `postgresAuditLog({ sinks })` — each `AuditSink` gets a copy of every entry; a sink is write-only and never read back |

## The jobs dashboard

`As of 2026-10`. Every `defineAdmin()` serves it; the app declares nothing. It is built from the admin's own pieces — four resources over the queue's operator surface (`JobIntrospection`) with a `repo:`, scopes, a row scope and actions, plus one overview screen. Zero JavaScript, like every admin screen.

| URL | Shows | Actions (`job:manage`) |
|---|---|---|
| `/admin/jobs` | tiles: ready, running, delayed, suspended, dead, workers, oldest ready (one `stats()`); done vs failed over `?range=1h\|24h\|7d\|30d` from the settle counters; volume, failure rate and mean duration per job name. Re-read every 30 s by a declared `<meta http-equiv="refresh">` | — |
| `/admin/jobs/runs` | one tab per state; the search box is an id prefix; filters by name, queue, state, tenant, created time | retry (dead rows), retry from a step, run now (waiting on its clock), cancel (live), remove |
| `/admin/jobs/runs/<id>` | input (redacted by `@ultimat3/jobs`), steps, error and stack, progress, tenant, trace, history | the row's own |
| `/admin/jobs/queues` | depth per state, paused, a link to the queue's jobs | pause, resume |
| `/admin/jobs/tasks` | schedule, IANA zone, last fire, next fire, paused | pause, resume, run now |
| `/admin/jobs/workers` | identity, host, queues, in flight, heartbeat | — |

| Rule | Detail |
|---|---|
| Read-only is a permission | `job:read` sees every screen and no control; `job:manage` (behind `admin:write`, or `admin:destroy` for remove) runs every action and is refused on the server when forged |
| "All matching" | retry, run now and remove over a state tab are ONE bulk call (`requeueMany`, `promoteMany`, `removeMany`, at most 1,000 rows, answering `{ affected, remaining }`). A tab the action is not for, no tab, or a narrowing by id or time is refused by name |
| Tenancy | an actor with an `orgId` sees that org's job rows only, and none of the fleet — queues, tasks, workers and the overview's figures are every tenant's. A platform operator is the actor without one. Override: `resources: { x_jobs: { rows } }` |
| No counts on the state tabs | `stats()` counts every tenant, so a count on a tab would show an org-scoped operator other orgs' numbers. The counts are the overview's tiles, which only a platform operator sees |
| Grants | the four resources share the permission noun `job` (`AdminResourceOptions.permission`), so `job:read` and `job:manage` are the whole vocabulary — never `x_jobs:read`. Both are declared by `defineAdmin()`; a role that should operate the queue is granted them in the role map |
| MCP | `admin.x_jobs.list`, `admin.x_jobs.read`, `admin.x_job_tasks.list`, `admin.action.job.retry`, `admin.action.job.queue.pause`, … — the resources' and actions' own tools |
| `/_x/jobs` | the same overview component over the dev process's queue |

## Screens and their source

The served admin, in every environment:

| Screen | Derived from | Shows |
|---|---|---|
| Entity list | the entity's columns, by type | keyset-paginated table; filters derived per column type ([The list](#the-list)) |
| Entity detail / edit | the entity's Standard Schema | a widget per column kind (`fields.ts`, the one type → widget table); input handed straight to the schema, so validation is the same one the write uses |
| Action form | `AdminAction.input` + its `permission` | a form per action, a 422 with each issue on its field, a 403 naming the permission |
| Jobs dashboard | the queue's operator surface (`JobIntrospection`) | the overview, runs, queues, tasks, workers — [above](#the-jobs-dashboard) |
| Audit | the `AuditLog` | every recorded entry, newest first — [above](#the-audit-log) |

The `/_x` dev dashboard (`devDashboard()`, `@ultimat3/admin/dev`) is a separate page that refuses to mount in production. Its tabs are `DEV_PANELS` in `packages/admin/src/dev/server.ts`; each has a `--json` twin at `/_x/<tab>?json=1`:

| Tab | Shows |
|---|---|
| `routes` | render mode, hydrate timing, offline strategy, budget, meta status. The admin's own routes are MOUNTED routes — `x routes` prints `defineAdmin() · admin:read + <table>:read` where a page names its file |
| `timeline` | one request as a flamegraph — SQL, cache hits, action calls, policy decisions — with the N+1 counted |
| `live` | every live subscriber, what it received, and the matcher's decision trace |
| `jobs` | the jobs overview component over the dev process's queue, its JSON payload (queues, runs, step traces, tasks) folded under it |
| `db` | the tables, read-only by default, and the schema diff against the migration history |
| `mail` | every caught message, rendered, grouped per locale |
| `cache` | the tag graph and the invalidation log |
| `policy` | rule-by-rule decision trace for the last request |
| `manifest` | the emitted `x.manifest.json` diffed against the committed one. Its `admin` section records each resource's filters, sorts, scopes, row scope, sections, related lists, actions and the audit store's `kind` |

## Authz

One authz seam for the whole admin: the rendered button, the HTTP call behind it, the MCP tool, the nav item, and the search result all ask the same interface.

| Property | Detail |
|---|---|
| Actor | the actor the HTTP pipeline resolved for the request — the app's own authenticator; `auth: { actor }` overrides |
| Decision | `roleAuthz()` by default — the role map decides each permission by name, and `admin:destroy` implies `admin:write` implies `admin:read`, as `staticAuthz` answers. `policyAuthz({ policies })` adapts the app's `policy` layer when a rule reads the row or the tenant |
| Admin permissions | `admin:read`, `admin:write`, `admin:destroy`, `admin:impersonate` — ordinary permission strings evaluated by the same policy engine |
| Per-entity gate | an actor needs the admin-level permission **and** the table's: `<table>:read` to list, open and search, `<table>:write` to create and edit, `<table>:delete` to delete. `defineAdmin()` declares them; `x g entity` / `x g resource` declare and grant a new table's three to the scaffold's `admin` role |
| View-only | a role holding `admin:read` and each `<table>:read` and nothing else — every write is refused by the decision that hid its button. Not a mode |
| Jobs and audit screens | `job:read` and `audit:read`, beside `admin:read`; every jobs action is `job:manage` |
| Denial | `{ allowed, permission, reason, trace }`; `reason` is an i18n key or a rule name, never a sentence |
| UI invariant | the UI cannot show what the call would refuse — one decision per request, consulted by every surface |
| Destructive ops | `delete` requires an echoed confirmation token and is always audited. Both are data in a table, not a code path in a view |
| Audit | every write and refusal is an `AuditLog` entry with a redacted field diff — [The audit log](#the-audit-log). `sensitive` columns are never rendered and never diffed |

### What it never does

| Never | Why |
|---|---|
| A second authz system | two authz systems is how every Meteor-like framework died. There is one `policy` layer |
| An admin-only user table or role table | admins are users with permissions; a parallel identity store drifts and gets forgotten in offboarding |
| A "superuser" bypass | there is no flag that skips policy evaluation |
| Writes without a policy | an action with no `policy` does not compile; the admin cannot invoke what does not exist |
| A raw SQL console that writes | read-only SQL only, statement-capped and row-capped. Writes and data-modifying CTEs are refused with `X_MCP_QUERY_REJECTED` |
| Offset pagination | offset re-scans every page and skips rows when the table is written to mid-page. Keyset only |
| Hidden framework internals as user data | `/_x` panels are dev-only and gated by role |

## MCP over the app's own actions

The admin exposes an MCP surface over the actions **the app already declared**, so the user's agents can drive the user's product with exactly the permissions the human has.

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

| Property | Consequence |
|---|---|
| Actor = the signed-in user's session | an agent can never exceed the human it acts for |
| Policies unchanged | no separate "API permissions" screen to get wrong |
| Tool list is generated | adding a feature adds a capability; deleting one removes it |
| Projected tools declare no MCP scope | adding one would be a second gate in front of the only gate that matters |
| Ships on | day-one agent access to operations, not a v3 roadmap item |
| Exposure | two surfaces, two defaults — and this catalog is the **only** exception in the framework. Inside the admin's own catalog a registered action becomes a tool unless it sets `mcp: { expose: false }`, because every tool here is already gated on an admin permission and the CRUD tools carry no `mcp` block at all. Everywhere else — the app MCP surface (`defineAppMcp`), the LLM tool list, `openapi.json`'s `x-ultimate.mcpTool` and `x.manifest.json` — one predicate decides, and it is opt-in: only `mcp: { expose: true }` makes a tool, and naming an un-exposed primitive in `defineAppMcp` is `X_MCP_TOOL_UNDECLARED` at boot ([Actions](Actions)) |

The projected tool calls `action.run(...)` — the same entry point the HTTP route calls. Policy evaluation lives inside `run`, so there is nothing to keep in sync. Details: [MCP and AI](MCP-And-AI).

## Theming

The generated admin reads the same 24 semantic colour roles as the app, through the same four blocks: light in `:root`, dark behind the media query, both mirrored under `html[data-theme]`. A raw hex in an admin stylesheet is the same `raw-colour` guard finding as anywhere else, and `ThemeTokenRef` is a template-literal type, so `--x-*` typechecks and a hex does not.

The `/_x` **dev** dashboard is a standalone page with no stylesheet pipeline, so it inlines its six channels — `bg`, `surface-raised`, `fg`, `fg-muted`, `line`, `accent` — into a `<style>` element. `As of 2026-08` it **derives** them from `@ultimat3/ui`'s `colorTokens` at render time rather than keeping a copy: the copy it used to keep went stale through the WCAG retune and shipped `line` on `surface-raised` at 1.16:1. The barrel is reached by dynamic `import()`, for the same reason the panels reach introspection that way — `/_x` stays out of the production graph → [Theming](Theming).

| Concern | Behavior |
|---|---|
| Theme | follows the OS; explicit `localStorage` choice wins; applied before first paint → [Theming](Theming) |
| Strings | every label through `t()`. `labelKey` fields in the permission and field tables exist so no view holds a sentence. Every key a declaration derives — branding, nav, titles, fields, sections, scopes, columns, action labels (`labelKey`, absent: `admin.action.<name>`) and their input fields — is `admin.catalogKeys()`; `x verify`'s `i18n` step asks each app catalog for exactly that list (`X_CATALOG_MISSING_KEYS`) → [I18n](I18n) |
| Timestamps | the admin refuses to render a timestamp without an IANA zone; the actor's zone comes from the session → [Timezones and dates](Timezones-And-Dates) |
| Money columns | `{ minor, currency }` formatted with `Intl.NumberFormat`; the raw minor value on hover → [Money](Money) |

## Render modes

**One shape for every generated route, from one call site** — `adminRouteConfig` in
[`packages/admin/src/routes.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/admin/src/routes.ts),
never an author's choice, `As of 2026-08`.

| Key | Value | Why |
|---|---|---|
| `render` | `ssr` | behind auth and with no SEO value, but it has to be correct on first byte. It was `spa` until 6.0.0 deleted that mode: nothing built the client bundle it preloaded and `renderSpa` never read the route's component, so every generated view served an empty `<div id="x-root">` |
| `offline` | `network-only` | an operator acting on stale operational data is worse than an error |
| `hydrate` | `never` | every control on a generated screen is a link or a native `<form method="post">` — paging, search, the forms, row actions — so the page ships **zero JavaScript** and has nothing to boot. It also means a generated screen declares **no island**: an island rendered on a route at `never` is `X_ISLAND_NOT_HYDRATED`, whose fix is to remove the `never` |
| `policy` | `permissions[0]`, always | the author never writes this `defineRoute` call, so the author cannot omit the guard; an empty permission list is `X_ADMIN_PAGE_UNGUARDED` at construction |

Interactivity is a screen you write yourself under `apps/admin/app/<feature>/` — a normal Ultimate
route, where `hydrate` derives from the island it declares.

The **request timeline** and the **live query inspector** are not admin routes: they are `/_x`
panels (`panel-timeline.ts`, `panel-live.ts`), mounted by `devDashboard()`, which throws rather
than mounting when `ROLE` and the environment say production. The live panel reads registered live
queries and their subscribers out of introspection — `@ultimat3/admin` does not depend on
`@ultimat3/realtime` and subscribes to nothing.

See [Routes and render modes](Routes-And-Render-Modes).

## Extending it

Own routes in your own app. Never fork the framework.

| Want | Do |
|---|---|
| A custom screen | `pages: [{ path, titleKey, permissions, component }]` on `defineAdmin` — same route table, same guard, framed in the shell. `x g admin:page <name>` writes it beside the declaration, under `apps/admin/app/admin/`. A path the admin already serves (`/jobs/*` included) is `X_ADMIN_PAGE_PATH_INVALID`. A screen that needs an island is a normal Ultimate route under `apps/admin/app/<feature>/` |
| A different control for one field | `resources: { <entity>: { fields: { <name>: { widget } } } }` — one of the `AdminWidget` kinds in `fields.ts`; a new column kind is a row in that table, not an app hook |
| A custom operation, on one row or many | `actions: [{ name, permission, entity, input?, when?, batch?, matching?, handle }]` on `defineAdmin` — a button on the detail and each list row, a row in the batch bar with `batch`, and an MCP tool `admin.action.<name>`. Grant its `permission` in the role map, or the `policy` step is `X_PERMISSION_UNGRANTED` |
| Different columns in a list | `resources: { <entity>: { listFields, labelField, columns } }` — `x g resource <name> --admin` writes the override, with `listFields` read off the entity, and lists it in `defineAdmin()` |
| Tabs, or a second audience | `scopes:` and `rows:` on the resource — never a second resource |
| A secret column | `.sealed()` on the entity: never listed, shown, searched or prefilled; the form writes it through a password input, and an empty box on an edit leaves it unchanged |
| Branding | `defineTheme({ colors, radius, font })` — the one override seam, validated not escaped → [Theming](Theming) |
| Hide an entity | the entity's policy denies `admin:read` — visibility is authz, not configuration |

No plugin API, in 1.x, 2.x, 3.x or 4.0.0 ([axiom](Home)). The extension point is that the admin is your app.

## Deployment

| Fact | Detail |
|---|---|
| Role | `ROLE=web`, the same process and image as the app — `serve-web.ts` mounts every declared admin beside the app's routes (`adminMountRoutes`) |
| Scaling | the web role's: stateless, on RPS |
| Health | the web role's `/healthz`, `/readyz` and SIGTERM drain |
| Isolation | none of its own: the admin is a path prefix (`basePath`) on the app's host. Restricting it to a network or a hostname is the ingress's job |
| A batch past its `threshold` | `admin.batch` jobs, run by the `worker` role; a worker process that never ran `defineAdmin` refuses the chunk with `X_ADMIN_MOUNT_MISSING` |

See [Deployment](Deployment).

## Rules

- One declaration, mounted by the framework. A hand-written page for an admin URL is a second server for it.
- One authz seam. The UI never shows what the call would refuse.
- Destructive operations confirm and audit — enforced by the permission table, not by a view.
- Read-only SQL, capped. No write console.
- Keyset pagination only.
- A list's state is its URL; a parameter the resource does not derive is refused, never ignored.
- A sealed column is never a filter, a scope predicate, a label or a computed column's input.
- Every write emits an audit diff with `sensitive` fields redacted.
- MCP runs with the human's own permissions. Projecting an `action` into an app MCP surface is opt-in — `mcp: { expose: true }`, the one rule every other surface reads too; inside the admin's own catalog, and nowhere else, a registered action opts *out* with `mcp: { expose: false }`.
- Extend with `pages:`, `resources:` and `actions:`, never by forking `@ultimat3/admin`.
- No island: every control is a link or a native form, and the admin ships zero JavaScript.

Source: [`packages/admin/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/admin/src)
