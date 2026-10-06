# @ultimat3/admin 🛠️

**Two dashboards live here. They are not the same thing — and they have two doors.**

| | `/_x` — framework dev dashboard | `admin` — generated app admin |
|---|---|---|
| Import | `@ultimat3/admin/dev` | `@ultimat3/admin` |
| Audience | you, debugging the framework | your operators, and their agents |
| Environment | development **only** — mounting it with `env=production` or `role=production` throws `X_DEV_DASHBOARD_IN_PROD` | production |
| Authz | none: it is your own machine | the app's policies, one decision per surface |
| Data | introspection calls (`describeRoutes`, `inspect`, `dependentsOf`, …) | the entity registry + repos |
| Shipped in the app image | never mounted | mounted at `/admin` |

## `/_x` panels

One panel per file. Each kills one question, and each is available as `--json` — the tab is a rendering of the payload, not a second source.

| Panel | Kills |
|---|---|
| `routes` | which handler serves this? — render mode, offline strategy, revalidate tags, budget |
| `timeline` | where did the time go? — a server-rendered waterfall of SQL, cache, action, policy spans (one row per span, bar placed by the payload's own `offset`/`width`), time per kind, and the N+1 detector's verdicts with their fix lines; the payload folded under it |
| `live` | what does each subscriber receive, and **why** — the matcher's decision trace |
| `jobs` | a ring of the recent runs by state (`DonutChart`), then the admin's own jobs overview (`/admin/jobs`'s component) over this process's queue; the payload — queue depth, step traces, retry-from-step target, dead letter — folded under it |
| `db` | psql in a tab (read-only twice: `assertReadOnly` refuses DML, and `readOnlySql(client)` — what a host wires as `runSql` — runs it in a `BEGIN READ ONLY` transaction with a timeout and `DEV_SQL_MAX_ROWS`), schema + drift (`null` unless a host wires the check) |
| `mail` | caught mail, rendered, per locale, with the locale gaps listed |
| `cache` | the tag graph — what invalidated what, and which tags are orphans |
| `policy` | the permission matrix per actor, every cell carrying its trace |
| `manifest` | emitted `x.manifest.json` diffed against the committed one |

```ts
import { staticAuthz } from '@ultimat3/admin';
import { defaultDevSources, devDashboard } from '@ultimat3/admin/dev';

declare const request: Request;
const authz = staticAuthz(['admin:read']);
const actors = [{ id: 'dev-admin', roles: ['admin'] }];

const dev = devDashboard({ sources: defaultDevSources({ authz, actors }) }); // throws in prod
// A drawn tab renders ui's components; their rules are in the app surface's stylesheet, so a host
// names its URL: devDashboard({ …, stylesheetHref: () => styleBundle().hrefFor('app') })
const response = await dev.handle(request); // null when the path is not /_x
await dev.json('jobs'); // the same payload /_x/jobs renders from
```

The root barrel does not re-export any of this: `x dev` mounts `/_x` without pulling a Solid
component tree into the process, and an admin view cannot reach a dev panel by accident.

## The generated admin

One call, a working CRUD admin **at a URL**: columns from the entity's columns, filters from indexed columns, validation from the entity's schema, labels from i18n keys, rows through the app's own typed handle. The app writes no page, no screen glue and no repo adapter.

```ts
import { type AdminDb, type AdminEntity, defineAdmin } from '@ultimat3/admin';

// Your app's `entity()` results and its `database()` handle — `@app/db` in a scaffolded app.
declare const posts: AdminEntity;
declare const users: AdminEntity;
declare const db: AdminDb;

export const admin = defineAdmin({ entities: [posts, users], db });
```

`x dev` and the container mount it: `/admin`, `/admin/posts`, `/admin/posts/new`,
`/admin/posts/<id>`, `/admin/posts/<id>/edit`, plus `/admin/search`, `/admin/audit` and the jobs
dashboard (`/admin/jobs`, below).

`/admin` itself opens on a KPI row — one `StatTile` per resource the actor may list, its figure
that resource's `AdminRepo.count()` over its `rows` scope, each tile a link to the list — and a
`DonutChart` of the same counts, then the permission matrix per resource. A resource the actor may
not list has no tile, no segment and no matrix; a repo with no `count()`, or one whose count the
store refuses (`X_TENANCY_UNSCOPED` for an actor with no org), has no tile and never fails the page.
A count reads no row, so it is not audited. One `count()` per listable resource per visit. Each
matrix is a closed `<details>` whose summary reads "N of M allowed".

| Input | What it is | Omitted |
|---|---|---|
| `entities` | the objects `entity()` returned — `adminEntitiesOf(db)` is every entity the handle serves | required |
| `db` | the app's `database()` handle. Each resource reads through its own table: tenancy, soft delete, sealing and invariants are the handle's, and the admin adds no predicate | `resources.<entity>.repo` per resource, or `X_ADMIN_REPO_UNBOUND` at declaration |
| `resources` | per-entity overrides — `listFields`, `labelField`, `columns`, `scopes`, `rows`, `sections`, `formGroups`, `related`, `fields.<name>.{sensitive,hintKey,on}`, `operations`, `repo`, `permission` (the noun its operations are named after; default the entity's name) | derived |
| `actions` | `AdminAction[]` — a `permission` (never optional) plus a handler; optional `input` schema, `when(row)`, `batch` | none |
| `pages` | custom screens, see below | none |
| `auth.actor` | who is acting | the actor the HTTP pipeline resolved for the request |
| `auth.authz` | the one decision path | `roleAuthz()` — the role map decides each permission by name |
| `audit` | `postgresAuditLog()` (the table `x_admin_audit`) or `memoryAuditLog({ sinks })` | a memory ring |

Three authz constructors, one interface: `roleAuthz()` (the default), `policyAuthz({ policies })`
when a rule reads the row or the tenant, `singlePolicyAuthz(policy)` when one grant runs the whole
admin.

### No script

Every route is `ssr`, `hydrate: 'never'`, and every control is a link or a native form: the pager
is `<Pagination hrefFor>`, a sort header is a link, scope tabs are links, the filter bar is one
GET form, a form posts at the URL that rendered it and a refused one comes back 422 with what was
typed. A write that worked is a 303. Every admin document is `noindex, nofollow`, and carries no
`og:*` or `twitter:*` tag (`@ultimat3/seo` withdraws them from every `noindex` document).

### The list an operator works in

The list's whole state is its URL — one parser and one builder (`pageRequestOf`, `listHref`):

| Parameter | Means | Refused when |
|---|---|---|
| `?cursor=<signed>` | keyset position on `(sort, id)` — any number of tied values, and NULLs (last ascending, first descending), are reached | never — an unreadable cursor is page one |
| `?sort=<field>:<asc\|desc>` | order; a bare field is `desc` | the field is not sortable, or the direction is neither |
| `?scope=<name>` | a declared scope; absent is the default one; `*` is NO scope, not even the default (a related card's "all" link) | no scope has that name; `*` cannot be declared |
| `?f.<field>=<value>` | a filter, by the field's default operator | the field is not a filter of the resource |
| `?f.<field>.<op>=<value>` | a named operator; repeat the parameter for `in` | the field's shape does not answer `<op>`, or the value is not the column's type — a number is decimal digits (no blank, hex or exponent), a date is one the calendar has |
| anything else | — | always |

A refusal is `X_ADMIN_FILTER_INVALID`, a 400 naming what the list does answer — never the
unfiltered list. An empty value is no parameter: a GET form submits every input it holds.

| Filter shape | Derived for | Control | Operators (first is the default) |
|---|---|---|---|
| `text` | a text column `LIKE` runs against — the label always, others when indexed | search box | `contains` `eq` `neq` `is-null` |
| `exact` | a uuid, `bigint` or `numeric` column | text box | `eq` `neq` `in` `is-null` |
| `choice` | an enum (its own values, labelled by the catalog), a locale, a zone | select | `eq` `neq` `in` `is-null` |
| `boolean` | a boolean | any / yes / no | `eq` |
| `range` | a number, a date, a timestamp (typed in UTC) | from / to | `eq` `neq` `gt` `gte` `lt` `lte` `is-null` |
| `reference` | a foreign key | the target's rows by label, or its lookup | `eq` `neq` `in` `is-null` |

Money, JSON, file, sealed and tenant columns derive no filter.

```ts
defineAdmin({
  entities: [tickets, owners],
  db,
  resources: {
    tickets: {
      labelField: 'title',
      // Tabs. At most one default; a count is one query per tab that asks for it.
      scopes: {
        open: { where: [{ field: 'status', op: 'eq', value: 'open' }], default: true, count: true },
        mine: { where: (actor) => [{ field: 'assigneeId', op: 'eq', value: actor.id }] },
      },
      // Who sees which rows at all — list, search, detail, lookup, labels and MCP alike.
      rows: (actor) => [{ field: 'region', op: 'eq', value: actor.locale ?? '' }],
      // Computed list columns: one of six renderers, or a component.
      columns: {
        age: { value: (row) => row.createdAt, render: 'relative-time' },
        state: { value: (row) => ({ label: row.status, tone: 'warning' }), render: 'badge' },
      },
    },
  },
});
```

| Declared | Rule |
|---|---|
| `scopes.<name>` | `where` is predicates or `(actor) => predicates`; `default: true` at most once; `count: true` reads `AdminRepo.count` — never the caller's filters, so a tab's number is the scope's size |
| `rows` | applied by every read of the resource; a row outside it is "not found", exactly as a missing one |
| `columns.<name>` | `render`: `badge` · `relative-time` · `money` · `truncate` · `link` · `json`, or `(props) => JSX`; the row it reads carries no sealed column; a name that is also an entity column is refused |
| `labelField` | what a reference to this resource SHOWS, linked to the row; read once per page per target, never per row |

A reference filter or input is a `<select>` of the target's rows when it has at most 50
(`LOOKUP_SELECT_MAX`), else an id box beside the target's lookup screen
(`/admin/<resource>/lookup`) — one derived lookup per resource, `contains` on its label, behind
its own `list` gate and row scope, keyset-paged. No picker endpoint is written in the app.

Statements a list page issues: 1 for the rows, 1 per scope with `count: true`, 1 per referenced
resource (2 for one that is picked from and has more than 50 rows). 50 rows, two reference columns
and three scopes of which one is counted: 4, or 6 when both targets are large.

### The detail page and the form

```ts
import type { AdminResourceOptions } from '@ultimat3/admin';

export const resources: Readonly<Record<string, AdminResourceOptions>> = {
  users: {
    // Titled groups; every field named in none falls into a default section drawn last.
    sections: [{ titleKey: 'admin.users.section.profile', fields: ['handle', 'displayName'] }],
    formGroups: [{ titleKey: 'admin.users.section.profile', fields: ['handle', 'displayName'] }],
    // hasMany relations, by the name @ultimat3/entity gives them — each drawn as THAT
    // resource's own list (its columns, its rows scope, its policy) filtered to this row.
    related: ['posts', 'media'],
    fields: {
      handle: { hintKey: 'admin.users.hint.handle', on: 'create' }, // set once, never edited
    },
  },
};
```

| Declared | Rule |
|---|---|
| `sections` / `formGroups` | a name that is not a drawn field, or that two groups claim, is `X_ADMIN_FIELD_UNSUPPORTED` at `defineAdmin` |
| `related` | a `hasMany` of the entity whose rows are a resource of this admin; anything else refused at `defineAdmin`. A target the actor may not list is left off the page |
| `on` | the field is an input on one side only, and a write from the other side drops it |
| `hintKey` | the line under the control, through `t()` |

The detail page's history card is `audit.entries({ entity, entityId, changes: true })` — and
`orgId` when the actor has one, as on `/admin/audit` — newest first, 20 per page, older pages by
keyset (`?history=`). Statements a detail page issues: 1 for
the row (2 with `rows`), 1 per related list, 1 per referenced target for the whole page, 1 for
the history with `postgresAuditLog`.

### Actions: a form, a row state, a batch

```ts
import type { AdminAction } from '@ultimat3/admin';
import { t } from '@ultimat3/schema';

declare function suspend(id: unknown, reason: unknown): Promise<void>;

export const suspendUser: AdminAction = {
  name: 'user.suspend',
  permission: 'users:suspend',
  entity: 'users',
  input: t.object({ reason: t.string.min(3) }), // the action's own form; absent: a confirm only
  when: (row) => row['suspended'] !== true, // the button, each list row, AND the server
  batch: { threshold: 200 }, // or `true`: always inline
  handle: async ({ input }) => suspend(input['id'], input['reason']),
};
```

| Piece | Behaviour |
|---|---|
| `input` | the button links to `<row>?action=<name>`; the form posts `input.<field>`, labelled `admin.input.<name>.<field>`; a refusal is a 422 with each issue on its field |
| `when(row)` | hides the button where it answers false and is asked again before the handler: `X_ADMIN_ACTION_NOT_APPLICABLE`, a 409. The row carries no sealed column |
| `batch` | the list's batch bar — checked rows, or every row the list's URL matches — each row through the button's gate and on the audit log, answered with `done` / `refused` / `failed` / `queued` / `remaining`. 200 rows inline per request (`MAX_BATCH_ROWS`), 1,000 queued (`MAX_BATCH_QUEUED_ROWS`); "all matching" continues from where it stopped |
| `matching` | "all matching" as ONE set-based call: handed the list's `where` (row scope, scope, filters), it answers `{ affected, remaining }` — a store's bounded bulk verb. Decided and audited once (`admin.batch.matching`); a destructive one types `<entity>:all matching`. Checked rows still run row by row. Requires `batch` |
| `batch.threshold` | past it, one `admin.batch` job per `chunk` (default: the threshold), run by a worker as the operator who queued it. The worker must load the module calling `defineAdmin` (`X_ADMIN_MOUNT_MISSING`) |
| destructive | one row: type `<entity>:<id>`; a batch: type `<entity>:<n> rows` |
| MCP | still ONE tool, `admin.action.<name>`; a batch action's takes `ids: [...]` |
| `labelKey` | the button's, the form's and the batch bar's label; absent: `admin.action.<name>` |

Every key a declaration derives — branding, nav, titles, fields, sections, scopes, columns, action
labels and their input fields — is `admin.catalogKeys()`, sorted. `x verify`'s `i18n` step asks
each of the app's catalogs for exactly that list (`X_CATALOG_MISSING_KEYS`).

No script, anywhere: row checkboxes join the bar's form by their `form` attribute, and a
confirmation is a server round trip. An action on a row the actor cannot see — gone, or outside
its `rows` — is refused whether or not it declares `when`.

### The jobs dashboard

Every `defineAdmin()` carries it; the app declares nothing. Four resources over the queue's
operator surface (`JobIntrospection`), each an ordinary resource with a `repo:`, and one screen:

| Path | What | Actions (`job:manage`) |
|---|---|---|
| `/admin/jobs` | depth tiles from one `stats()`, workers, oldest ready; done-vs-failed over `?range=1h\|24h\|7d\|30d`; volume, failure rate and mean duration per job name. A declared 30 s `<meta http-equiv="refresh">` | — |
| `/admin/jobs/runs` (`x_jobs`) | one tab per state; filters by id prefix (the search box), name, queue, state, tenant, created time; a row's input (redacted by `@ultimat3/jobs`), steps, error and stack, progress, trace | retry (dead), retry from a step, run now (waiting on its clock), cancel (live), remove — the batched ones over checked rows or "all matching" through `requeueMany` / `promoteMany` / `removeMany` |
| `/admin/jobs/queues` (`x_job_queues`) | depth per state, paused | pause, resume |
| `/admin/jobs/tasks` (`x_job_tasks`) | schedule, zone, last fire (`taskFires()`), next fire (`nextTaskRun`), paused | pause, resume, run now |
| `/admin/jobs/workers` (`x_job_workers`) | identity, host, queues, in flight, heartbeat | — |

| Permission | Grants |
|---|---|
| `job:read` (`JOB_READ`) | every jobs screen and MCP read; no control renders |
| `job:manage` (`JOB_MANAGE`) | every action, behind `admin:write` (or `admin:destroy` for remove) — refused on the server when forged |

An actor with an `orgId` sees that org's job rows only (`jobRowScope`) and none of the fleet —
queues, tasks, workers and the overview's figures are every tenant's. Override either with
`resources: { x_jobs: { rows } }`. MCP: `admin.x_jobs.list`, `admin.x_jobs.read`,
`admin.x_job_tasks.list`, `admin.action.job.retry`, `admin.action.job.queue.pause`, … — the
admin's own projection. `/_x/jobs` draws the same overview component over the dev queue.

### The audit log

`postgresAuditLog()` writes one row per audited write to `x_admin_audit`, in the same
transaction as the write (`AuditLog.atomic`) — a CRUD write, an action's handler, a `matching`
set and a queued batch's enqueues alike, so an entry that cannot be written rolls the work back
and the log holds one `failed` entry — and reads it back by keyset. An allowed READ is not
written unless `reads: true` — a refused one always is. Sealed and `sensitive` values reach the
table only as `[redacted]`. `memoryAuditLog()` is a ring that forgets at every restart. The
table is applied at boot with every other framework table (`@ultimat3/cli`'s `FRAMEWORK_SCHEMA`),
from the leaf module `@ultimat3/admin/schema` (`SQL_ADMIN_AUDIT_TABLE`, `ADMIN_AUDIT_TABLE`) —
no migration, no screen loaded to install it.

### A sealed column

`.sealed()` on the entity is read by nothing here: no list column, no detail row, no filter, no
search field, no MCP argument. It is in `resource.secretFields` — a list of its own — and the form
renders it as a password input with no value. Empty on an edit means unchanged; a required one is
required to create. The audit diff records *that* it changed, as `[redacted]`.

### The views are TSX, and the pieces come apart

Every renderer is an ordinary component in an ordinary `.tsx` file importing `@ultimat3/ui` —
`AdminList`, `AdminForm`, `AdminDetail`, `AdminActions`, `Widget`, `AdminLayout` are each exported,
so a table can be lifted into a screen the generator never wrote:

```tsx
import { AdminList, listHref, Widget } from '@ultimat3/admin';

<AdminList resource={resource} page={page} error={null} ctx={ctx} actor={actor} authz={authz}
  basePath={admin.basePath} request={request} scope={scope} counts={counts}
  hrefFor={(location) => listHref(admin.basePath, resource, location)} />;
<Widget field={field} value={row.total} ctx={ctx} mode="read" />;
```

`Widget` takes the field and the raw row value, not pre-derived props: `widgetProps()` is the
guard (money is minor units, a timestamp has an IANA zone) and the component calls it, so there is
no way to render a cell that skipped it.

### Mounting it yourself

`x dev` and the container already do. A host that is neither asks the route table per request:

```ts
import { adminRouteMatch } from '@ultimat3/admin';

const matched = adminRouteMatch(admin, url.pathname);            // null → 404
const answer = await matched.route.respond({
  ctx: await admin.requestCtx(request), params: matched.params, url: url.href,
  method: 'GET', form: null,                                     // or 'POST' + the parsed form
});
// { kind: 'document', status, body } — the framed screen — or { kind: 'redirect', location }
```

`respond` is the only way in: the screen decides before it renders, so a host serialises and
nothing else.

### Custom pages

The bespoke ops screen is the common case, not the corner: a reconciliation fixer, a proxy health
board, a deploy button. Declare it in `pages:` and it becomes a real admin route.

```tsx
// admin/ops/page.tsx — a component, nothing framework-shaped about it
export function OpsPage(props: AdminPageProps) {
  return <OpsBoard counts={await mediaStateCounts()} />;
}

// admin/index.ts
defineAdmin({
  entities: [posts],
  pages: [
    {
      path: '/ops',                       // rooted at basePath → /admin/ops
      titleKey: 'admin.ops.title',
      navGroup: 'admin.group.operations', // omit to keep it out of the nav
      permissions: ['ops:read'],          // `admin:read` is composed in front of it
      component: OpsPage,
    },
  ],
  auth,
});
```

| What you get | How |
|---|---|
| a row in `app.routes`, `adminRoutes()`, `x routes`, `x manifest` | `pageRoutes()` folds it in beside the generated screens; every admin route is in the framework's route list as a MOUNTED route with its permissions |
| a nav item that disappears for an actor who cannot open it | `NavItem.permissions` → `visibleNav` |
| a `defineRoute({ policy })` you never wrote and cannot omit | `adminRouteConfig` composes `permissions[0]` into it |
| a per-request refusal, audited, answered 403, before your component runs | `guardedScreen()` wraps it in `decideAll` |
| the shell — nav, who is acting, search | the same frame every generated screen gets |

**Testing one.** A page component needs a `CrudCtx`, and `adminTestCtx()` mints it from a grant
list — no admin instance, no session:

```ts
import { adminTestCtx } from '@ultimat3/admin';
import { renderView } from '@ultimat3/testing';

const view = await renderView(OpsPage, {
  ctx: adminTestCtx({ granted: ['admin:read', 'ops:read'] }),
  params: {},
  url: 'http://localhost/admin/ops',
});
```

`x g admin:page <name>` emits exactly this test beside the page.

**The guard is not yours to remember.** `adminRoutes()` hands a host the *screen*, never the
component you wrote, and `AdminPageProps.ctx` is required by the type — a page component cannot be
called without the handle the guard decides on. `permissions: []` throws
`X_ADMIN_PAGE_UNGUARDED` where it is written, not on the first unauthenticated request. A path
that shadows a generated screen throws `X_ADMIN_PAGE_PATH_INVALID` the same way.

Custom pages are `render: 'ssr'`, `hydrate: 'never'`: the guard runs on the server, so there is
nothing to ship and nothing to decide twice. A refused one answers 403.

### Splitting the admin across files

`defineAdmin` takes **plain values** — `entities`, `db`, `resources`, `actions`, `jobs`, `pages`,
`nav`, `branding`, `auth`, `audit`. Every one of them can be imported from its own module, so the cut is
along the input's own keys and there is exactly one layout:

```
app/admin/
  index.ts              defineAdmin({ … }) — composition only, no logic
  auth.ts               actor() + policyAuthz({ policies })
  nav.ts                groups, order, extras
  <resource>/
    resource.ts         the AdminResourceOptions entry (listFields, sensitive, labelField)
    actions.ts          the AdminAction[] for this entity
    pages/<name>.tsx    a custom page component for this entity, if any
  pages/<name>.tsx      an app-wide custom page (ops, reconciliation, deploy)
```

`index.ts` imports each and composes. Nothing here is a framework rule — it is what the input
shape already is, written down once so two apps do not invent two layouts. `x g admin` emits it.

### Derived from the entity, and only from it

| Admin decision | Read from |
|---|---|
| field type + widget | `$meta.kind`, refined by `values` (select) and `references` (reference) |
| one line vs prose | `text({ max })` has a length; `text()` does not |
| read-only | a **generated** default (`uuid()`, `defaultNow()`, `onUpdateNow()`) or a key column |
| filters, sort | `$meta.index` / `unique` / `primaryKey` — never an unindexed column, except the label (the list's search box) |
| row address | `$primaryKey[0]`, composite keys included |
| validation | `$schema`, the entity's own Standard Schema |
| write-only | `.sealed()` — in `secretFields`, and in no list a reader iterates |

`sensitive`, a fixed `currency` and `labelField` have no entity source and are never guessed: declare them in `resources: { <entity>: { … } }` or they are absent.

### Rules it enforces for you

| Rule | Where |
|---|---|
| Money is `{ minor, currency }` — a float throws `X_ADMIN_FIELD_UNSUPPORTED` | `widgetProps` |
| A timestamp never renders without an IANA zone | `assertZone` |
| Pagination is keyset — `AdminListQuery` has no `offset` field | `pagination.ts` |
| A cursor is signed by `@ultimat3/core` and scoped to its resource — a forged or borrowed one is page one, never another table's position | `pagination.ts` |
| A button an actor cannot press is never rendered, and the call is refused by the same decision | `action-gate.ts` |
| Destructive operations re-confirm (`<entity>:<id>`) and are always audited | `permissions.ts`, `crud.ts` |
| Every mutation and every denial is on the audit log, with a before/after diff | `audit.ts` |
| An edit carries the row's version (`_version`); a row changed since the form was drawn is a 409, never overwritten. An instant posted back as drawn is left out of the patch | `row-version.ts`, `form-decode.ts` |
| Branding aliases tokens only — `accent: '#7c3aed'` is a compile error | `theme.ts` |

Reads are audited too, and on both branches: `adminDetail` keys its entry on the row,
`adminList` and `adminSearch` key theirs on the table (`entityId: null`), and a refusal is an
entry of its own. `AdminSearchResult.audit` carries one entry per resource the call decided
about — searched or refused — so a jump box that walked every readable entity leaves a trace.

## AI-first

The admin exposes **its own MCP surface**, derived from the same resources and gated by the same authz — an agent sees exactly the tools its actor could have clicked.

```ts
import { adminMcp, adminMcpTools } from '@ultimat3/admin';

export const mcp = adminMcp({ app: admin, actor: (session) => actorFor(session.token) });
adminMcpTools(admin, ctx); // admin.post.list · admin.post.read · admin.search · admin.action.post.publish
```

The list tool takes the list screen's own grammar: `scope` by name and `where` as
`[{ field, op?, value }]`, through the same validator a URL passes — and the resource's `rows`
narrows what an agent reads whatever it sends.

Opt-in AI panes, each declaring the scope it needs (`aiPanes({ enable: ['anomaly'] })`):

| Pane | Scope |
|---|---|
| `anomaly` | `jobs:read`, `metrics:read` |
| `nl-query` | `db:read-only` |
| `backlog-forecast` | `jobs:read`, `metrics:read` |

Panes are off until enabled, and `runAiPane` refuses (never no-ops) without a runner.

## Errors

`X_ADMIN_ENTITY_UNKNOWN` · `X_ADMIN_FIELD_UNSUPPORTED` · `X_ADMIN_FILTER_INVALID` · `X_ADMIN_ACTION_NOT_APPLICABLE` · `X_ADMIN_MOUNT_MISSING` · `X_ADMIN_POLICY_MISSING` · `X_ADMIN_REPO_UNBOUND` · `X_ADMIN_PAGE_UNGUARDED` · `X_ADMIN_PAGE_PATH_INVALID` · `X_ADMIN_DENIED` · `X_ADMIN_TOOL_FORBIDDEN` · `X_ADMIN_INVALID` · `X_DEV_DASHBOARD_IN_PROD` · `X_NOT_IMPLEMENTED` (an unwired `/_x` source, carrying the wiring line).

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `AdminActionDuplicateError` | `X_ADMIN_ACTION_DUPLICATE` | `src/errors.ts` |
| `AdminActionNotApplicableError` | `X_ADMIN_ACTION_NOT_APPLICABLE` | `src/errors.ts` |
| `AdminEntityUnknownError` | `X_ADMIN_ENTITY_UNKNOWN` | `src/errors.ts` |
| `AdminFieldUnsupportedError` | `X_ADMIN_FIELD_UNSUPPORTED` | `src/errors.ts` |
| `AdminFilterInvalidError` | `X_ADMIN_FILTER_INVALID` | `src/errors.ts` |
| `AdminMountMissingError` | `X_ADMIN_MOUNT_MISSING` | `src/errors.ts` |
| `AdminPagePathInvalidError` | `X_ADMIN_PAGE_PATH_INVALID` | `src/errors.ts` |
| `AdminPageUnguardedError` | `X_ADMIN_PAGE_UNGUARDED` | `src/errors.ts` |
| `AdminPolicyMissingError` | `X_ADMIN_POLICY_MISSING` | `src/errors.ts` |
| `AdminRepoUnboundError` | `X_ADMIN_REPO_UNBOUND` | `src/errors.ts` |
| `DevDashboardInProdError` | `X_DEV_DASHBOARD_IN_PROD` | `src/errors.ts` |
| `DevSourceUnavailableError` (extends core's `NotImplementedError`) | `X_NOT_IMPLEMENTED` | `src/errors.ts` |
