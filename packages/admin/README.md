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
| `timeline` | where did the time go? — flamegraph of SQL, cache, action, policy spans + the N+1 count |
| `live` | what does each subscriber receive, and **why** — the matcher's decision trace |
| `jobs` | queue depth, step traces, retry-from-step target, dead letter |
| `db` | psql in a tab (read-only; `assertReadOnly` refuses DML), schema + drift (`null` unless a host wires the check) |
| `mail` | caught mail, rendered, per locale, with the locale gaps listed |
| `cache` | the tag graph — what invalidated what, and which tags are orphans |
| `policy` | the permission matrix per actor, every cell carrying its trace |
| `manifest` | emitted `x.manifest.json` diffed against the committed one |

```ts
import { devDashboard, defaultDevSources } from '@ultimat3/admin/dev';

const dev = devDashboard({ sources: defaultDevSources({ authz, actors }) }); // throws in prod
const response = await dev.handle(request); // null when the path is not /_x
await dev.json('jobs'); // the same payload /_x/jobs renders from
```

The root barrel does not re-export any of this: `x dev` mounts `/_x` without pulling a Solid
component tree into the process, and an admin view cannot reach a dev panel by accident.

## The generated admin

One call, a working CRUD admin: columns from the entity's columns, filters from indexed columns, validation from the entity's schema, labels from i18n keys.

`entities` takes the entities themselves — the objects `entity()` returned, not their `describeEntities()` projection. The admin reads `$columns`, `$primaryKey`, `$schema` and `$describe()` off them; `RegisteredEntity` in `registry.ts` is the compile-time check that it may.

```ts
import { defineAdmin, adminRoutes, policyAuthz, memoryAuditLog } from '@ultimat3/admin';
import { posts, users } from '@app/db/schema';

export const admin = defineAdmin({
  entities: [posts, users],
  // `AdminAction` is the admin's own shape: a `permission` (never optional) plus a handler.
  actions: [{ name: 'post.publish', permission: 'post:publish', entity: 'posts', handle }],
  resources: { posts: { repo: postsAdminRepo, listFields: ['title', 'status', 'publishedAt'] } },
  branding: { nameKey: 'admin.brand.name', accent: '--x-color-brand', mode: 'system' },
  auth: { actor: (request) => session(request), authz: policyAuthz({ policies }) },
  audit: memoryAuditLog({ sinks: [auditTable] }),
});

export const routes = adminRoutes(admin); // generated views `spa`, custom pages `ssr`, all gated
```

### The views are TSX, and the pieces come apart

There is no view DSL here, and there will not be one. Every renderer is an ordinary SolidJS
component in an ordinary `.tsx` file importing `@ultimat3/ui` — `AdminList`, `AdminForm`,
`AdminDetail`, `Widget`, `AdminLayout` are each exported on their own, so a table can be lifted
out of its page and dropped into a screen the generator never wrote:

```tsx
import { AdminList, AdminForm, Widget } from '@ultimat3/admin';

<AdminList resource={admin.resource('posts')} page={page} ctx={ctx} … />;   // just the table
<Widget field={field} value={row.total} ctx={ctx} mode="read" />;          // just one cell
```

`Widget` takes the field and the raw row value, not pre-derived props: `widgetProps()` is the
guard (money is minor units, a timestamp has an IANA zone) and the component calls it, so there is
no way to render a cell that skipped it. `mode` is `read` or `edit`; an edit cell also takes the
`control` the surrounding `<Field>` hands its child, and `onInput`.

An admin route is an ordinary `route` primitive; an admin action is an ordinary `action`. Nothing
in this package is written in a second language that only the dashboard understands — the escape
hatch is the same TSX as the main path, which is why there is no cliff to fall off when a screen
stops being CRUD.

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
| a row in `app.routes`, `adminRoutes()`, `x manifest` | `pageRoutes()` folds it in beside the generated screens |
| a nav item that disappears for an actor who cannot open it | `NavItem.permissions` → `visibleNav` |
| a `defineRoute({ policy })` you never wrote and cannot omit | `adminRouteConfig` composes `permissions[0]` into it |
| a per-request refusal, audited, before your component runs | `guardedPage()` wraps it in `decideAll` |

**The guard is not yours to remember.** `adminRoutes()` hands the router the *wrapped* component,
never the one you wrote, and `AdminPageProps.ctx` is required by the type — a page component
cannot be called without the handle the guard decides on. `permissions: []` throws
`X_ADMIN_PAGE_UNGUARDED` where it is written, not on the first unauthenticated request. A path
that shadows a generated screen throws `X_ADMIN_PAGE_PATH_INVALID` the same way.

Custom pages are `render: 'ssr'`, `hydrate: 'never'`: the guard runs on the server, so there is no
shell to ship and nothing to decide twice.

### Serving an admin URL from your own route file

A host whose router is file-based writes its own `page.tsx` for an admin URL. Take the gate from
the route table — never type it a second time:

```ts
import { adminRouteFor } from '@ultimat3/admin';
import { admin } from './admin';

const route = adminRouteFor(admin, `${admin.basePath}/users`);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: route.policy, // `defineAdmin()`'s, from `permissionsForOperation('users', 'list')`
  meta: () => ({ title: t('admin.users.title') }),
});
```

`route.policy` is the same object `route.config.policy` carries, so the gate has one declaration
and one reader. A `path` the admin does not declare throws `X_ADMIN_PAGE_PATH_INVALID` listing the
paths that would have worked — a page serving an admin URL the admin never built is a screen whose
permissions nothing composed.

### Splitting the admin across files

`defineAdmin` takes **plain values** — `entities`, `resources`, `actions`, `jobs`, `pages`, `nav`,
`branding`, `auth`, `audit`. Every one of them can be imported from its own module, so the cut is
along the input's own keys and there is exactly one layout:

```
app/admin/
  index.ts              defineAdmin({ … }) — composition only, no logic
  auth.ts               actor() + policyAuthz({ policies })
  nav.ts                groups, order, extras
  <resource>/
    resource.ts         the AdminResourceOptions entry (listFields, sensitive, labelField)
    repo.ts             the AdminRepo binding
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
| filters, sort | `$meta.index` / `unique` / `primaryKey` — never an unindexed column |
| row address | `$primaryKey[0]`, composite keys included |
| validation | `$schema`, the entity's own Standard Schema |

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

Opt-in AI panes, each declaring the scope it needs (`aiPanes({ enable: ['anomaly'] })`):

| Pane | Scope |
|---|---|
| `anomaly` | `jobs:read`, `metrics:read` |
| `nl-query` | `db:read-only` |
| `backlog-forecast` | `jobs:read`, `metrics:read` |

Panes are off until enabled, and `runAiPane` refuses (never no-ops) without a runner.

## Errors

`X_ADMIN_ENTITY_UNKNOWN` · `X_ADMIN_FIELD_UNSUPPORTED` · `X_ADMIN_POLICY_MISSING` · `X_ADMIN_PAGE_UNGUARDED` · `X_ADMIN_PAGE_PATH_INVALID` · `X_ADMIN_DENIED` · `X_ADMIN_TOOL_FORBIDDEN` · `X_ADMIN_INVALID` · `X_DEV_DASHBOARD_IN_PROD` · `X_NOT_IMPLEMENTED` (an unwired `/_x` source, carrying the wiring line).
