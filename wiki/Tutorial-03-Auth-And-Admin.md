# Tutorial 3 — auth and admin

Authentication produces one thing: an `Actor`. Nothing downstream authorizes on a session row, a user row or an api key — HTTP, the typed client, jobs, live queries and MCP all read the same actor and hand it to the same `policy`. One authz system, never two.

`As of 2026-11-03`. Every command and every output on this page was re-run in the app tutorials 1 and 2 leave — the example `post` slice and the `todo` slice — built from this tree's packages (`scripts/scaffold-smoke-overrides.ts`). The session flow ran against a real Postgres; the admin routes were requested from `x dev`. The reference app excerpt under [Detail pages](#detail-pages-actions-batches) is quoted from `examples/dummy`, not run.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · **3** · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## The three pieces

| Piece | Package | Owns |
|---|---|---|
| identity | `@ultimat3/auth` | passwords, sessions, OAuth, MFA, api keys → an `Actor` |
| authorization | `@ultimat3/policy` | permissions, roles, `can()` predicates — the only evaluator |
| operations UI | `@ultimat3/admin` | the admin app's screens, the `/_x` dev panels |

`@ultimat3/auth` and `@ultimat3/admin` are scaffold dependencies: `x new` lists both in the root `package.json` at the version it was released with, beside every other `@ultimat3/*` package. Nothing to add. Every `@ultimat3/*` package releases in lockstep, and a mixed-version install is a combination nobody tested.

## Roles first — they cost one file

`x new` writes the role map, `apps/web/shared/roles.ts`: `member` and `admin`, with `admin` inheriting `member`. Each `x g resource` adds its grants there — after tutorial 2, beside the example `post` slice's:

```ts
// apps/web/shared/roles.ts — the roles, after `x g resource todo`
import { defineRoles } from '@ultimat3/policy';

export const roles = defineRoles({
  member: {
    description: 'Signed in. Reads the app surface.',
    grants: ['dashboard:read', 'post:read', 'todo:read'],
  },
  admin: {
    description: 'Runs the app: the /admin surface, plus everything a member may do.',
    grants: ['admin:read', 'admin:write', 'admin:destroy', 'job:read', 'audit:read',
      'post:write', 'posts:read', 'posts:write', 'posts:delete',
      'todo:write', 'todos:read', 'todos:write', 'todos:delete'],
    inherits: ['member'],
  },
});
```

Roles are sugar. Everything expands to a flat permission set before any policy runs, so a rule never reasons about the hierarchy, and a cycle is caught once at expansion. `defineRoles()` merges into one map and refuses a role two modules define differently (`X_ROLE_REDEFINED`) — keep every role in this one file. `todo:*` is the policy's permission; `todos:*` is the table's, which the [admin](#the-admin-surface) asks beside its own `admin:*`.

```bash
bunx x policy list
```

```text
  permission         roles         actions                 queries
  admin:destroy      admin         -                       -
  admin:impersonate  -             -                       -
  admin:read         admin         -                       -
  admin:write        admin         -                       -
  audit:read         admin         -                       -
  dashboard:read     admin,member  -                       -
  job:delete         -             -                       -
  job:manage         -             -                       -
  job:read           admin         -                       -
  job:write          -             -                       -
  post:read          admin,member  -                       postList
  post:write         admin         archivePost,createPost  -
  posts:delete       admin         -                       -
  posts:read         admin         -                       -
  posts:write        admin         -                       -
  todo:read          admin,member  -                       todoList
  todo:write         admin         archiveTodo,createTodo  -
  todos:delete       admin         -                       -
  todos:read         admin         -                       -
  todos:write        admin         -                       -
  16 permission(s) no action or query enforces:
    admin:destroy
    …
✓ 20 permission(s), 2 role(s), 4 enforced by a declaration
```

The `actions` and `queries` columns are the reason to run this: a permission enforced by **no action or query** is listed under the table. Here those are the admin's and the jobs dashboard's, which their own screens enforce — for a permission of your own, the list is a grant that does nothing.

## The denial matrix, before you ship

```bash
bunx x policy explain todo:write
```

```text
  action archiveTodo — policy todo:write
  actor      verdict  deciding    reason
  anonymous  deny     todo:write  no actor for todo:write
  admin      deny     todo:write  todo:write predicate returned false
  member     deny     todo:write  actor lacks todo:write
    evaluated with no request input and no row — a rule reading either decides again on the real request
  action createTodo — policy todo:write
  …
✓ todo:write — allowed for 0 of 6 actor evaluation(s)
```

Read the `reason` column, not the verdict:

| Reason | Means |
|---|---|
| `actor lacks todo:write` | the grant is missing — a role problem, fix it in `defineRoles` |
| `predicate returned false` | the grant is held, the predicate said no. Here that is tenancy, with no `input.orgId` to compare against outside a request |
| `no actor for …` | anonymous. Every surface agrees on this one |

`<subject>` resolves against a permission, an action name, a query name, then an action's HTTP path — so the `fix:` line an `X_FORBIDDEN` prints is runnable whichever of the four the throwing surface had. Verdicts come from `policyMatrix()` over the app's real `Policy` objects, never a second evaluation.

## Sessions

`x new` writes the app's one `Auth`, built on first use because `defineAuth` reads the database and the lockout limiter the boot installs:

```ts
// apps/web/app/auth/auth.ts, as `x new` writes it
import { type Auth, defineAuth, postgresAuthAdapter } from '@ultimat3/auth';

let built: Auth | undefined;

export const appAuth = (): Auth => {
  built ??= defineAuth({ adapter: postgresAuthAdapter() });
  return built;
};
```

The defaults: a 30-day absolute and a 7-day idle session, cookie `__Host-x_session`, rotated on a privilege change. `authenticator.ts` beside it resolves that cookie on every request. What the scaffold does **not** write is a sign-in page — see [Known gaps](Known-Gaps).

Register, log in, resolve — the real flow, against Postgres, with `const auth = appAuth()` and `org` the seeded demo org (`DEMO_ORG_ID` from `apps/web/shared/demo-org.ts`):

```ts
await register(auth, { email, password, orgId: org, roles: ['member'] });
const { actor, token, cookie } = await login(auth, { email, password, ip });
```

```json
{"actor":{"kind":"user","id":"01a1a22f-…","orgId":"9c7ca12f-7aa0-57c4-a1cf-79b3afc8d1dd",
  "roles":["member"],"scopes":[],"permissions":[],"facts":{}},
 "cookie":"__Host-x_session=<token>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"}
```

`authenticate(auth, token)` answers the same actor. `permissions: []` is correct — direct grants are for service tokens and break-glass accounts. The role is what carries the set, and `actorHas()` expands it against `roles.ts`:

```json
{"todo:read":true,"todo:write":false,"admin:read":false}
```

A `member` reads todos; the scaffold grants `todo:write` to `admin` only, so writing is an edit to `roles.ts`. Anonymous (`anonymousActor()`) holds nothing:

```json
{"anon":"anonymous","hasRead":false}
```

### Signing out clears the browser too

`logout(auth, token)` ends the session row. The **response** does the rest, through
`signOutHeaders()`, in 21.0.0:

```ts
import { logout, signOutHeaders } from '@ultimat3/auth';
import { appAuth } from './auth';

const auth = appAuth();
declare const token: string;
declare const headers: Headers; // the action's ctx.headers

await logout(auth, token);
for (const [name, value] of signOutHeaders({ session: auth.sessions.policy })) {
  headers.append(name, value);
}
```

What it appends, verbatim:

```json
[["set-cookie","__Host-x_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"],
 ["clear-site-data","\"cache\", \"storage\""]]
```

After `logout`, `authenticate(auth, token)` refuses the token: `X_UNAUTHENTICATED`.

| Header | Effect |
|---|---|
| `set-cookie` (with `session`) | the framework session cookie, expired. An app with its own cookie omits `session` and sets its own |
| `Clear-Site-Data: "cache", "storage"` (`SIGN_OUT_CLEAR_SITE_DATA`) | the browser drops what the previous member left on the origin: the page store's IndexedDB, local storage, the service worker and its cached pages. **Never `"cookies"`**, which would also clear the signed-out cookie this response sets |

**Trade-off, deliberate:** a PWA's offline cache does not outlive the person it was cached for.
The next load reinstalls the worker and re-precaches. Browsers act on `Clear-Site-Data` only in a
secure context (HTTPS, or `localhost`). A sign-out with no response at all falls back on the page
boot, which wipes every stored scope but the current principal's
([Realtime](Realtime#tier-3-shipped-in-2100)). The reference app's `endSession` action uses it.

### Failures say one thing

Wrong password, unknown address and disabled account are indistinguishable in message **and** duration — the first two below were each run, and print the same `code` and `cause`:

```json
{"code":"X_UNAUTHENTICATED",
 "cause":"the email and password combination did not match an account — re-enter them before issuing the reset below, which mails a single-use token",
 "fix":"issueVerification(runtime, { purpose: 'password-reset', identifier: email, locale })"}
```

### The cookie

`__Host-x_session`, from `sessionCookie(token, policy)`.

| Attribute | Closes |
|---|---|
| `HttpOnly` | XSS reading `document.cookie` |
| `Secure` | a network attacker lifting it off plaintext |
| `SameSite=Lax` | CSRF — not attached to cross-site POSTs |
| `__Host-` + `Path=/` + no `Domain` | a sibling subdomain overwriting it (session fixation) |

Absolute and idle expiry are evaluated **independently**: activity never moves the ceiling. Session ids are opaque random tokens and only `sha256(secret)` reaches the database.

### The four actor kinds

| Kind | From | Carries |
|---|---|---|
| `user` | a session | the row's `roles`, expanded to permissions by policy. Scopes empty — a browser session is not scope-limited |
| `agent` | an api key | **exactly** the key's scopes. Never the owning user's roles |
| `service` | machine-to-machine inside the deployment | scopes only, no roles |
| `anonymous` | no credential | nothing |

`resolveActor()` is the single funnel. An agent that can do more than its key says is the failure mode that funnel exists to prevent.

### Auth tables

`@ultimat3/auth` exports `AUTH_TABLES` — the DDL `PostgresAuthAdapter` expects, as plain strings, so what
auth stores is verifiable by reading. **Every boot applies them** (`@ultimat3/cli`'s
`FRAMEWORK_SCHEMA`), the upgrade of an older `x_users` included, so an app writes no migration for
`x_users`, `x_sessions`, `x_accounts`, `x_verifications` or `x_api_keys`, `As of 2026-09-23`. The
per-table constants that were once pasted into migrations are gone (22.0.0).

## The admin surface

Two different things share the word.

| Surface | Is | Gated by | Available |
|---|---|---|---|
| `/_x` | the **dev** dashboard from `@ultimat3/admin/dev` — routes, timeline, live, jobs, db, mail, cache, policy, manifest, services, boundaries (`DEV_PANELS`; `x dev` prints the 11) | dev-only, never mounted in production | in `x dev`, immediately |
| `apps/admin/` | the app's own admin, served by `defineAdmin()` under `ROLE=web` | the app's role map (`roleAuthz()`), permission by permission | in `x dev`, immediately: a list, a detail and a form per entity, the audit log, and the jobs dashboard at `/admin/jobs`. Measured: `/admin`, `/admin/todos` and `/admin/jobs` answer 200 to the development viewer (`admin`) and 403 with the `myapp_dev_role=member` cookie |

The scaffold writes a declaration, not a page, `As of 2026-10`:

```ts
// apps/admin/app/admin/admin.ts
import { db } from '@myapp/db';
import { adminEntitiesOf, defineAdmin } from '@ultimat3/admin';

export const admin = defineAdmin({
  // Every entity the handle serves: `x g entity` adds one there, and it is an admin screen on
  // the next boot. Name them one by one instead — `entities: [post]` — to leave a table out.
  entities: adminEntitiesOf(db),
  db,
});
```

There is no `page.tsx`, no repo adapter and no screen glue: `defineAdmin()` serves
`/admin/<table>` from the entity and reads rows through the app's handle. A page file on a path the
admin mounts is `X_ROUTE_DUPLICATE`; a `defineAdmin()` under `apps/*/src/`, which no boot
imports, is `X_ADMIN_UNSCANNED`. Who may do what is `apps/web/shared/roles.ts`: `admin:read` +
`<table>:read` to look, `admin:write` + `<table>:write` to create or edit, `admin:destroy` +
`<table>:delete` to delete; `x g entity` and `x g resource` grant a new table's three to `admin`.
`job:read` opens the jobs dashboard and `job:manage` runs its controls. A permission a mounted
admin route asks for and no role grants is `X_PERMISSION_UNGRANTED` in the `policy` step.

### Per-entity screens

```bash
bunx x g resource note --admin
```

`--admin` adds two files to the slice — `apps/web/app/note/admin/resource.ts` and its test — and
lists the override under `resources:` in `apps/admin/app/admin/admin.ts` in the same run
(`resources: { notes: noteAdminResource }`, with its import). In this app, which already holds the
`todo` slice and its wiring:

```text
✓ wrote 43 file(s) for resource note — next: …
``` The
override is the only hand-written part; fields, operations, filters and forms derive from the entity.

```ts
export const noteAdminResource: AdminResourceOptions<AdminRow> = {
  // Columns of the entity, in its own order. A name that is not one is X_ADMIN_FIELD_UNSUPPORTED
  // at boot — delete the line to let the admin pick them.
  listFields: ['title', 'price', 'createdAt'],
  pageSize: 25,
};
```

### Detail pages, actions, batches

Everything past the list is declared on the same call. The reference app's operator view
(`examples/dummy/apps/admin/app/admin/admin.ts`), cut to one resource and one action:

```ts
import { db, LIVE_RUN_STATUSES, runEvents, runs } from '@postly/db';
import { api } from '@postly/web/api';
import { defineAdmin } from '@ultimat3/admin';
import { useContext } from '@ultimat3/core';

export const admin = defineAdmin({
  entities: [runs, runEvents],
  db,
  resources: {
    runs: {
      operations: ['list', 'detail', 'search'],
      scopes: {
        running: { where: [{ field: 'status', op: 'eq', value: 'running' }], count: true },
        failed: { where: [{ field: 'status', op: 'eq', value: 'failed' }], count: true },
      },
      // A `hasMany` of the entity, drawn as `run_events`' own list filtered to this run.
      related: ['run_events'],
    },
  },
  actions: [
    {
      name: 'run.cancel',
      permission: 'run:write',
      entity: runs.$name,
      // Decides the button on each row, and is asked again on the server before `handle`.
      when: (row) => LIVE_RUN_STATUSES.some((status) => status === row['status']),
      // A checkbox per row and an "all matching" choice in the list's batch bar.
      batch: true,
      handle: ({ input }) => {
        const actor = useContext().actor;
        return api.actions.cancelRun.as(actor, {
          orgId: actor.orgId ?? '',
          runId: String(input['id']),
        });
      },
    },
  ],
});
```

| Declared | Served |
|---|---|
| `sections`, `formGroups`, `fields.<f>.hintKey`, `fields.<f>.on` | titled groups on the detail and the forms; a hint under a control; a field on one side of create/update only |
| `related` | the related resource's own list — its columns, its row scope, its policy — under the row |
| `input: t.object({ … })` on an action | the action's own form at `/admin/<entity>/<id>?action=<name>`, 422 with each issue on its field |
| `when` | the button only where it applies; a forged post is `X_ADMIN_ACTION_NOT_APPLICABLE` (409) |
| `batch` | checked rows or every row the list's URL matches, each through the button's gate and audited; past `batch.threshold` rows, `admin.batch` jobs on the worker |

No island ships for any of it: the checkboxes join the batch form by their `form` attribute and a
confirmation is a server round trip, so the admin stays at zero JavaScript. Every action is also
an MCP tool, `admin.action.<name>`.

### The rules the admin never breaks

| Never | Why |
|---|---|
| a second authz system | two authz systems is how every framework of this shape died |
| an admin-only user or role table | admins are users with permissions; a parallel identity store gets forgotten in offboarding |
| a superuser bypass | there is no flag that skips policy evaluation |
| offset pagination | offset re-scans every page and skips rows under concurrent writes. Keyset only |
| a SQL console that writes | read-only, statement-capped, row-capped; writes and data-modifying CTEs are `X_MCP_QUERY_REJECTED` |

Full surface: [Admin dashboard](Admin-Dashboard).

## Agents inherit the human, exactly

An action carrying `mcp: { expose: true }` becomes an MCP tool whose authorization **is** the action's `policy` object — `@ultimat3/mcp`'s projection calls the action's own `invoke`, so the policy evaluated is the very object `createTodo.policy` holds. The actor is the signed-in user's session, so an agent can never exceed the human it acts for. No trusted-tool mode, no second permission table, no "API permissions" screen to get wrong.

A tool a caller may not see is absent from `tools/list` and answers ToolNotFound, never Forbidden.

## Where the gate catches you

| Mistake | Step | Code |
|---|---|---|
| an action with no `policy` | `typecheck` | build error — the field is required |
| a permission string nothing declared | `typecheck` | `PermissionRegistry` augmentation narrows `can()` |
| a route reading a table with no org predicate | `contract` | `X_TENANCY_UNSCOPED` |
| a grant nothing enforces | — | not a gate; read the `x policy list` columns |
| a permission a mounted admin route asks for that no role grants | `policy` | `X_PERMISSION_UNGRANTED` |
| an app rule's `can()` naming a permission only `defineAdmin()` declared, never the app's own `definePermissions()` | `policy` | `X_PERMISSION_BORROWED` |

## Next

[Tutorial 4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime): a durable job with replayed steps, a cron task with a required IANA zone, and a live query that patches per subscriber.

Related: [Policies and authz](Policies-And-Authz) · [Admin dashboard](Admin-Dashboard) · [MCP and AI](MCP-And-AI) · [Configuration](Configuration)
