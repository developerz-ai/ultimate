# @postly/admin

The admin dashboard: `app/admin/admin.ts` declares it with `defineAdmin`, and `mcp.ts` projects it
for agents with `adminMcp` at `POST /admin/mcp`. `app/admin/admin.test.ts` proves it constructs
against this app's real entities and actions, that the role map opens it, and that the run
console's operator view does what it declares; `mcp.test.ts` that the agent surface is mounted.

**Mounted** — `x dev` and the container serve every screen under `/admin`, because the app scan
evaluates `apps/admin/app/**` and `defineAdmin` registers what it declares. There is no page file.

## What the declaration buys

| Declared | Derived |
|---|---|
| `entities: [orgs, members, posts, comments, connections, runs, runEvents]` | a resource per entity at `/admin/<entity name>` — list columns, filters and searchable columns from the column metadata, tenancy from each entity's tenant column, sealed columns (`credential`, `exit`) never shown |
| `db` | every resource reads and writes through the app's typed handle |
| `resources.runs` | read-only (`operations`), `running` / `failed` tabs with counts, `related: ['run_events']` — a run's events drawn as `run_events`' own list |
| `actions` | a toolbar button per app action on its own entity (`orgs:upgradePlan`, `members:inviteMember`, `posts:publishPost`), running the action's one callable; `run.cancel` on each live run (`when`) and over a selection (`batch`), through the console's own `cancelRun` |
| `branding: { nameKey: 'admin.title' }` | the dashboard's title, through `t()` |

Who may open what is the role map in `apps/web/shared/policies.ts`: the owner holds `admin:read|write|destroy`
and `<table>:<verb>` for each resource. A permission the dashboard asks for that no role grants is
`X_PERMISSION_UNGRANTED` in the gate's `policy` step.

`likes` and `plans` are left out on purpose: both key on more than one column, and
`@ultimat3/admin` refuses a composite primary key (`X_ADMIN_FIELD_UNSUPPORTED`).

A toolbar action whose policy carries no permission, or more than one, throws
`X_ADMIN_POLICY_MISSING` at import rather than guessing a permission.

## The agent surface

`mcp.ts` — `adminMcp({ app: admin, path: '/admin/mcp', include: 'exposed', actor })` — projects the
same dashboard as MCP tools, plus the app's exposed actions and queries, mounted beside the web's
`/mcp` because the mount serves every `apps/<app>/mcp.ts`. Built there and never under `app/`: the
scan evaluates it after every primitive registered (`X_MCP_INCLUDE_EARLY` otherwise). Who calls it
is `resolveAgentToken` (`apps/web/app/auth/agent-token.ts`, as `x new` writes it): an issued API key
in every environment, held to its `admin:*` scopes — no org key scope is one, so an org key is
answered an empty dashboard — and, under `x dev` from this machine alone,
`Authorization: Bearer dev-agent.<role>`, an agent holding that role in the demo org
(`dev-agent.owner` sees every tool, `dev-agent.reader` none of the writes). No token, or one this
process does not honour, is a 401. Answered per caller — a tool the actor may
not use is absent from `tools/list`, and a direct call answers not-found:

| Tools | For |
|---|---|
| `admin.<entity>.list` · `.read` · `.create` · `.update` · `.delete` | each writable resource |
| `admin.<entity>.list` · `.read` | `runs`, `run_events` |
| `admin.action.<name>` | each action, `run.cancel` included |
| `admin.search` | the shell's search |

## Rules

- No business logic here. If admin needs a rule, it belongs in `@postly/core` or the feature's
  service, where the web app and the worker can use it too.
- No admin-only policy. A rule that exists only for admin is a second authz system.
- Adding an entity to `ENTITIES` is the entire change needed to administer it — plus its grants.
