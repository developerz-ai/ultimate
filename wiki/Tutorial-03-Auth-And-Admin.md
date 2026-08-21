# Tutorial 3 — auth and admin

Authentication produces one thing: an `Actor`. Nothing downstream authorizes on a session row, a user row or an api key — HTTP, the typed client, jobs, live queries and MCP all read the same actor and hand it to the same `policy`. One authz system, never two.

`As of 2026-08`. Every output on this page was executed against a `create-ultimate@1.1.0` app with the [tutorial 2](Tutorial-02-First-Feature) `todo` slice in place.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · **3** · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## The three pieces

| Piece | Package | Owns |
|---|---|---|
| identity | `@ultimat3/auth` | passwords, sessions, OAuth, MFA, api keys → an `Actor` |
| authorization | `@ultimat3/policy` | permissions, roles, `can()` predicates — the only evaluator |
| operations UI | `@ultimat3/admin` | the admin app's screens, the `/_x` dev panels |

`@ultimat3/auth` and `@ultimat3/admin` are **not** scaffold dependencies. Add them when you need them:

```bash
bun add @ultimat3/auth@1.1.0 @ultimat3/admin@1.1.0
```

Pin the exact version. Every `@ultimat3/*` package releases in lockstep and a mixed-version install is a combination nobody tested.

## Roles first — they cost one file

`x new` writes no role map, so `x policy list` reports `0 role(s)` and every actor in the matrix holds nothing. One leaf module both surfaces already import fixes it:

```ts
// apps/web/shared/roles.ts
import { defineRoles } from '@ultimat3/policy';

export const roles = defineRoles({
  reader: { description: 'Reads the org’s todos.', grants: ['todo:read', 'dashboard:read'] },
  member: { description: 'Writes todos.',          grants: ['todo:write'], inherits: ['reader'] },
  admin:  { description: 'Runs the workspace.',    grants: ['admin:read'], inherits: ['member'] },
});
```

Roles are sugar. Everything expands to a flat permission set before any policy runs, so a rule never reasons about the hierarchy, and a cycle is caught once at expansion. `defineRoles()` replaces the map wholesale — app state, called exactly once.

```bash
bunx x policy list
```

```text
  permission  roles                actions                 queries
  todo:read   admin,member,reader  -                       todoList
  todo:write  admin,member         archiveTodo,createTodo  -
✓ 2 permission(s), 3 role(s), 2 enforced by a declaration
```

The `actions` and `queries` columns are the reason to run this: a permission enforced by **nothing** is a grant that does nothing, and the table says so.

## The denial matrix, before you ship

```bash
bunx x policy explain todo:write
```

```text
  action archiveTodo — policy todo:write
  actor      verdict  deciding    reason
  anonymous  deny     todo:write  no actor for todo:write
  admin      deny     todo:write  todo:write predicate returned false
  member     deny     todo:write  todo:write predicate returned false
  reader     deny     todo:write  actor lacks todo:write
    evaluated with no request input and no row — a rule reading either decides again on the real request
  action createTodo — policy todo:write
  …
✓ todo:write — allowed for 0 of 8 actor evaluation(s)
```

Read the `reason` column, not the verdict:

| Reason | Means |
|---|---|
| `actor lacks todo:write` | the grant is missing — a role problem, fix it in `defineRoles` |
| `predicate returned false` | the grant is held, the predicate said no. Here that is tenancy, with no `input.orgId` to compare against outside a request |
| `no actor for …` | anonymous. Every surface agrees on this one |

`<subject>` resolves against a permission, an action name, a query name, then an action's HTTP path — so the `fix:` line an `X_FORBIDDEN` prints is runnable whichever of the four the throwing surface had. Verdicts come from `policyMatrix()` over the app's real `Policy` objects, never a second evaluation.

## Sessions

```ts
// apps/web/shared/auth.ts
import { BuiltinAdapter, defineAuth } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: new BuiltinAdapter(),      // Postgres via @ultimat3/db; MemoryAdapter for tests
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
});
```

Register, log in, resolve — the real flow, real output:

```ts
await register(auth, { email, password, orgId: org, roles: ['member'] });
const { actor, cookie } = await login(auth, { email, password });
```

```json
{"actor":{"kind":"user","id":"019ff1d3-…","orgId":"00000000-…-000000000002",
  "roles":["member"],"scopes":[],"permissions":[]},
 "cookiePrefix":"__Host-x_session=9zh6XI_"}
```

`permissions: []` is correct — direct grants are for service tokens and break-glass accounts. The role is what carries the set, and `actorHas()` expands it:

```json
{"todo:write":true,"admin:read":false}
```

A `member` writes todos and does not reach the admin. Anonymous holds nothing:

```json
{"anon":"anonymous","hasWrite":false}
```

### Failures say one thing

Wrong password, unknown address and disabled account are indistinguishable in message **and** duration:

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

`@ultimat3/auth` exports `AUTH_TABLES` — the DDL `BuiltinAdapter` expects, as plain strings, so what auth stores is verifiable by reading. Nothing wires them into a migration at 1.1.0 (`x db gen` does not know the constant, and it is [broken anyway](Tutorial-02-First-Feature#migrations)). Paste each statement into its own migration file, following the one-statement rule from tutorial 2.

## The admin surface

Two different things share the word.

| Surface | Is | Gated by | Available |
|---|---|---|---|
| `/_x` | the **dev** dashboard from `@ultimat3/admin`, 11 panels | dev-only, never mounted in `ROLE=web` | in `x dev`, immediately |
| `apps/admin/` | a generated Ultimate app running `ROLE=web` | `admin:read` on the route config | a one-page shell; you build the screens |

The scaffolded shell, `As of 2026-08`:

```ts
// apps/admin/app/admin/page.tsx
export const config = defineRoute({
  render: 'ssr',
  hydrate: 'idle',
  offline: 'network-only',
  // Behind auth, and `ssr` is the one mode that can be: it renders per request, so the guard runs
  // on the server before the page does. `static` and `isr` refuse a policy outright.
  policy: { permission: 'admin:read' },
  budget: { js: '120kb' },
  meta: ({ t }) => ({ title: t('admin.home.title'), description: t('admin.home.description') }),
});
```

**`app/admin/page.tsx`, not `app/page.tsx`** — the directory is the URL relative to the surface root, so the shallower path resolves to `/` and collides with `apps/web/site/page.tsx`: `x dev` loads both surfaces into one route table, and the scaffold used to fail its own `x routes` with `X_ROUTE_DUPLICATE`. `x new` now writes the deeper path, and `/admin` is also `@ultimat3/admin`'s own `basePath` default, so the two agree rather than merely not clashing. Nothing to move.

### Per-entity screens

```bash
bunx x g resource note --admin
```

```text
  + apps/web/app/note/admin/resource.ts
  + apps/web/app/note/admin/resource.test.ts
```

The override is the only hand-written part; fields, operations and detail layout derive from the entity.

```ts
export const noteAdminResource: AdminResourceOptions<AdminRow> = {
  titleKey: 'admin.note.title',
  listFields: ['id', 'title', 'createdAt'],
  pageSize: 25,
};
```

It imports `@ultimat3/admin`, which the scaffold does not depend on — `TS2307: Cannot find module '@ultimat3/admin'` until you `bun add @ultimat3/admin@1.1.0`. Wire it in once with `defineAdmin({ entities: [...], resources: { notes: noteAdminResource } })`.

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

An action carrying `mcp: { expose: true }` becomes an MCP tool whose authorization **is** the action's `policy` object — `createTodo.tool().policy === createTodo.policy` is `true`. The actor is the signed-in user's session, so an agent can never exceed the human it acts for. No trusted-tool mode, no second permission table, no "API permissions" screen to get wrong.

A tool a caller may not see is absent from `tools/list` and answers ToolNotFound, never Forbidden.

## Where the gate catches you

| Mistake | Step | Code |
|---|---|---|
| an action with no `policy` | `typecheck` | build error — the field is required |
| a permission string nothing declared | `typecheck` | `PermissionRegistry` augmentation narrows `can()` |
| a route reading a table with no org predicate | `contract` | `X_TENANCY_UNSCOPED` |
| a grant nothing enforces | — | not a gate; read the `x policy list` columns |

## Next

[Tutorial 4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime): a durable job with replayed steps, a cron task with a required IANA zone, and a live query that patches per subscriber.

Related: [Policies and authz](Policies-And-Authz) · [Admin dashboard](Admin-Dashboard) · [MCP and AI](MCP-And-AI) · [Configuration](Configuration)
