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
| `routes` | which handler serves this? — render mode, offline strategy, budget, meta |
| `timeline` | where did the time go? — flamegraph of SQL, cache, action, policy spans + the N+1 count |
| `live` | what does each subscriber receive, and **why** — the matcher's decision trace |
| `jobs` | queue depth, step traces, retry-from-step target, dead letter |
| `db` | psql in a tab (read-only; `assertReadOnly` refuses DML), schema diff vs migrations |
| `mail` | caught mail, rendered, per locale, with the locale gaps listed |
| `cache` | the tag graph — what invalidated what, and which tags are orphans |
| `policy` | the permission matrix per actor, every cell carrying its trace |
| `manifest` | emitted `x.manifest.json` diffed against the committed one |

```ts
import { devDashboard, defaultDevSources } from '@ultimat3/admin/dev';

const dev = devDashboard({ sources: defaultDevSources({ authz, actors }) }); // throws in prod
const response = await dev.handle(request); // null when the path is not /_x
await dev.json('jobs'); // the same payload `x dev --panel jobs --json` prints
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

export const routes = adminRoutes(admin); // every page `spa`, `network-only`, noindex
```

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

Single-row reads are audited; list pages are not (volume).

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

`X_ADMIN_ENTITY_UNKNOWN` · `X_ADMIN_FIELD_UNSUPPORTED` · `X_ADMIN_POLICY_MISSING` · `X_DEV_DASHBOARD_IN_PROD` · `X_NOT_IMPLEMENTED` (an unwired `/_x` source, carrying the wiring line).
