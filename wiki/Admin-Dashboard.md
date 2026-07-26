# Admin dashboard

`apps/admin/` is a generated Ultimate app running `ROLE=web`. Same router, same policies, same tokens, same MCP surface. Not a bolted-on panel, not a mounted third-party package, not a second framework inside yours.

It derives itself from `x.manifest.json`. Adding an entity adds a screen. Deleting an action removes a runner. Nothing to register.

## Screens and their source

| Screen | Derived from | Shows |
|---|---|---|
| Entity list | `entity` columns + indexes | keyset-paginated table; indexed columns become the filters (a filter with no index is a table scan) |
| Entity detail / edit | the entity's Standard Schema | form widgets per column kind; input handed straight to the schema, so validation is the same one the action uses |
| Action runner | `action` input schema + `policy` | a form per action, a denial reason instead of a disabled button with no explanation |
| Job + queue view | `job` definitions, retry policy, queue depth | per-queue pending/running/failed, plus a **step timeline** per run with attempts, durations, and which step retried |
| Live-query inspector | `query` with `live: true` | initial snapshot, incremental patches as they arrive, per-subscriber policy filter results |
| Cache tag graph | `cache.invalidates` + `revalidate.tags` | what a given write will evict, across all four tiers, before you run it |
| i18n key coverage | catalog diff vs extracted keys | per-locale missing / unused / arity-drift counts, linked to the file and line |
| Error-code explainer | every package's `src/errors.ts` | `X_*` → cause, exact fix command, docs URL |
| Route table | `defineRoute` config | render mode, hydrate timing, offline strategy, budget, meta status |
| Policy panel (`/_x`) | `policy` registry | rule-by-rule decision trace for the last request |

Every screen has a `--json` twin, because the same data is reachable from the CLI and from MCP.

## Authz

One authz seam for the whole admin: the rendered button, the HTTP call behind it, the MCP tool, the nav item, and the search result all ask the same interface.

| Property | Detail |
|---|---|
| Actor | the signed-in user's session — Better Auth, same as the app |
| Decision | the app's `policy` layer, adapted into `AdminAuthz` by a bridge, not reimplemented |
| Admin permissions | `admin:read`, `admin:write`, `admin:destroy`, `admin:impersonate` — ordinary permission strings evaluated by the same policy engine |
| Per-entity gate | an actor needs the admin-level permission **and** the entity's own policy to pass |
| Denial | `{ allowed, permission, reason, trace }`; `reason` is an i18n key or a rule name, never a sentence |
| UI invariant | the UI cannot show what the call would refuse — one decision per request, consulted by every surface |
| Destructive ops | `delete` requires an echoed confirmation token and is always audited. Both are data in a table, not a code path in a view |
| Audit | every write is a span + a log line + a redacted field diff. `sensitive` columns are never rendered and never diffed |

### What it never does

| Never | Why |
|---|---|
| A second authz system | two authz systems is how every Meteor-like framework died. There is one `policy` layer |
| An admin-only user table or role table | admins are users with permissions; a parallel identity store drifts and gets forgotten in offboarding |
| A "superuser" bypass | there is no flag that skips policy evaluation |
| Writes without a policy | an action with no `policy` does not compile; the admin cannot invoke what does not exist |
| A raw SQL console that writes | read-only SQL only, statement-capped and row-capped. Writes and data-modifying CTEs are refused with `X_MCP_READONLY_VIOLATION` |
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

The projected tool calls `action.run(...)` — the same entry point the HTTP route calls. Policy evaluation lives inside `run`, so there is nothing to keep in sync. Details: [MCP and AI](MCP-And-AI).

## Theming

Reads `apps/admin/shared/tokens/` — the same nine semantic colour roles as the app. Light in `:root`, dark in the media query, both mirrored in `html[data-theme]` overrides. A raw hex in an admin component is the same lint failure as anywhere else.

| Concern | Behavior |
|---|---|
| Theme | follows the OS; explicit `localStorage` choice wins; applied before first paint → [Theming](Theming) |
| Strings | every label through `t()`. `labelKey` fields in the permission and field tables exist so no view holds a sentence → [I18n](I18n) |
| Timestamps | the admin refuses to render a timestamp without an IANA zone; the actor's zone comes from the session → [Timezones and dates](Timezones-And-Dates) |
| Money columns | `{ minor, currency }` formatted with `Intl.NumberFormat`; the raw minor value on hover → [Money](Money) |

## Render modes

| Surface | Mode | Why |
|---|---|---|
| Login / error pages | `ssr` | no shell to precache, must be correct on first byte |
| List and detail screens | `stream` | shell instantly, table streams when the query resolves |
| Job step timelines, live inspector | `spa` + live query | behind auth, entirely interactive, no SEO value |
| Offline | `network-only` | an operator acting on stale operational data is worse than an error |

See [Routes and render modes](Routes-And-Render-Modes).

## Extending it

Own routes in your own app. Never fork the framework.

| Want | Do |
|---|---|
| A custom screen | add a route under `apps/admin/app/<feature>/`; it is a normal Ultimate route |
| A custom widget for a column kind | register a field widget in `apps/admin/shared/fields.ts`; unknown column kinds fall back to a read-only text widget rather than crashing |
| A custom bulk operation | write an `action` with a `policy` and `mcp.expose`; it appears as a runner **and** an MCP tool |
| Different columns in a list | declare the entity's `labelColumn` / column metadata; the admin reads the registry, not a config file per screen |
| Branding | edit `apps/admin/shared/tokens/` |
| Hide an entity | the entity's policy denies `admin:read` — visibility is authz, not configuration |

No plugin API before v1 ([axiom](Home)). The extension point is that the admin is your app.

## Deployment

| Fact | Detail |
|---|---|
| Role | `ROLE=web`, same image as the app |
| Scaling | on RPS, stateless, behind the CDN like any web role |
| Health | `/healthz`, `/readyz`, graceful SIGTERM drain |
| Isolation | a separate hostname; the app's `web` role does not serve admin routes |
| Branch previews | gets its own preview URL and SW cache namespace per build ID |

See [Deployment](Deployment).

## Rules

- Generated from the manifest. A hand-registered screen is drift.
- One authz seam. The UI never shows what the call would refuse.
- Destructive operations confirm and audit — enforced by the permission table, not by a view.
- Read-only SQL, capped. No write console.
- Keyset pagination only.
- Every write emits an audit diff with `sensitive` fields redacted.
- MCP on by default over the app's own actions, with the human's own permissions.
- Extend by adding routes to `apps/admin/`, never by forking `@ultimat3/admin`.

Source: [`packages/admin/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/admin/src)
