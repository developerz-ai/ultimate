# @postly/admin

The admin dashboard, in one file: `src/index.ts` declares it with `defineAdmin` and projects it for
agents with `adminMcp`. `src/index.test.ts` is what proves it constructs against this app's real
entities and actions.

**Declared, not mounted** — `As of 2026-09-23`. Nothing serves these routes or the MCP route:
an app contributes actions, queries and pages to the server (`packages/cli/src/serve.ts`), and
there is no seam for a raw `Route`. `index.test.ts` pins that as a fact somebody chose. The mounted
admin in this repo is the deployed demo's (`dummy/social-media-clone/apps/admin`).

## What the declaration buys

`defineAdmin` receives four keys here — `branding`, `entities`, `actions` and `auth`:

| Declared | Derived |
|---|---|
| `entities: [orgs, members, posts, comments]` | a resource per entity, served at `/admin/<entity name>` (`/admin/orgs`, never a guessed plural) — list columns, filters and the searchable columns come from the column metadata, tenancy from each entity's own tenant column |
| `actions` | a toolbar button per action on its own entity (`orgs:upgradePlan`, `members:inviteMember`, `posts:publishPost`), running the action's one callable (`action.as(actor, input)`) — the same input parse, policy and handler as over HTTP |
| `auth: { actor, authz: policyAuthz({ policies }) }` | the actor the app's pipeline already resolved, and every admin permission mapped onto the app's own `can('org:administer')` — no admin-only policy |
| `branding: { nameKey: 'admin.title' }` | the dashboard's title, through `t()` |

`likes` and `plans` are left out on purpose: both key on more than one column, and
`@ultimat3/admin` refuses a composite primary key (`X_ADMIN_FIELD_UNSUPPORTED`).

A toolbar action whose policy carries no permission, or more than one, throws
`X_ADMIN_POLICY_MISSING` at import rather than guessing a permission.

## The agent surface

`adminMcp({ app: admin, actor })` projects the same dashboard as MCP tools, answered per caller —
a tool the actor may not use is absent from `tools/list`, and a direct call answers not-found:

| Tools | Count |
|---|---|
| `admin.<entity>.list` · `.read` · `.create` · `.update` · `.delete` | 4 entities × 5 |
| `admin.action.publishPost` · `admin.action.inviteMember` · `admin.action.upgradePlan` | 3 |
| `admin.search` | 1 |

24 in all, asserted by `index.test.ts`. The agent acts as the signed-in person, so it can never
exceed the permissions of the person it acts for.

## Rules

- No business logic here. If admin needs a rule, it belongs in `@postly/core` where the web app
  and the worker can use it too.
- No admin-only policy. A rule that exists only for admin is a second authz system.
- Adding an entity to `ENTITIES` is the entire change needed to administer it.
