# @ultimat3/mcp 🤖

The MCP surface. An agent that can reach this package needs no framework documentation — it
asks instead of guessing.

## The dev server: `x mcp serve`

| Tool | Scope | Answers |
|---|---|---|
| `routes.list` | `dev:read` | route table — url, render mode, offline strategy, hydrate, budget |
| `schema.describe` | `dev:read` | entities with columns, types, invariants |
| `policies.list` | `dev:read` | every policy: permission, subject, enforcement points |
| `actions.describe` | `dev:read` | actions + queries: input/output schema, policy, cache tags, MCP exposure |
| `jobs.inspect` | `dev:read` | job definitions, retry policy, steps (omit `name` for all) |
| `queue.depth` | `dev:read` | pending / running / failed per queue |
| `manifest.read` | `dev:read` | `x.manifest.json` verbatim |
| `errors.explain` | `dev:read` | stable `X_*` code → cause + exact fix command + docs |
| `db.query` | `db:read` | **read-only, enforced four ways** — SELECT-only role, `BEGIN READ ONLY`, one-statement parse, 5s/1000-row/256 KiB caps |
| `db.migrate` | `db:migrate` | **branch DB only** — refuses production and any non-branch target |
| `tests.run` | `dev:test` | runs the suite (executes project code) |
| `verify.run` | `dev:test` | `x verify` — the shippable contract |
| `logs.tail` | `dev:logs` | last N lines, optionally per runtime role |

`db.query` and `db.migrate` are gated *and* say so in their own description, so a model that
reads only the catalog still knows what it is holding.

### `db.query`'s four layers

| Layer | Mechanism | Where |
|---|---|---|
| 1. Role | `ultimate_readonly` — `NOLOGIN`, `SELECT` on every table present and future, nothing on sequences; assumed with `SET LOCAL ROLE` inside the transaction, never via a second connection string | `@ultimat3/db` |
| 2. Transaction | `BEGIN READ ONLY` … `ROLLBACK` on one reserved connection — Postgres refuses the write even if a grant is wrong | `@ultimat3/db` |
| 3. Parse | one statement, a read leader, no mutating keyword at statement level, no lock, no `pg_read_file`-class call — on a form with literals and comments blanked | `readonly-sql.ts` |
| 4. Limits | `SET LOCAL statement_timeout`, a hard 1000-row ceiling (`limit` clamps into it, never past it) and a 256 KiB byte cap | `query-limits.ts` |

The answer carries `guards` — the layers that actually engaged — plus `truncatedBy` and `bytes`.
A layer that could not engage (a managed Postgres that refuses `CREATE ROLE`) is **absent from
the list**, never assumed. Truncation is never silent.

## One authz system, two surfaces

Every `action` with `mcp: { expose: true }` becomes a tool for free, and the tool's `handle`
calls the **same `action.run`** the HTTP route calls. Policy evaluation lives inside `run`.

```
HTTP  POST /api/publishPost  ─┐
                              ├─→ action.run({ input, actor }) ─→ policy ─→ handler
MCP   tools/call publishPost ─┘
```

A projected tool declares **no `scope`** — adding one would put a second gate in front of the
only gate that matters, and the two would eventually disagree. There is no MCP-specific
authorization code to review, because there is none.

## Security posture: three outcomes, hidden ≠ forbidden

| Refused by | Declared by | Answer | Wire |
|---|---|---|---|
| role | `visibleTo` | omitted from `tools/list`, **ToolNotFound** on call, no `data` | `-32601` |
| scope | `scope` | **Forbidden**, naming the missing scope + a runnable fix | `-32600`, `X_MCP_SCOPE_DENIED` |
| policy | the primitive's own `policy` | `isError` result carrying code/cause/fix | `X_POLICY_DENIED` |

Forbidden confirms a tool exists, which turns an authz boundary into a catalog an agent can
enumerate by probing. So a role-hidden tool is indistinguishable from an absent one — even
for a caller holding every scope in the system. A scope refusal is the opposite case: the
caller was already shown the tool and can legitimately fix this, so hiding it would only
strand a well-behaved client.

| Rule | Detail |
|---|---|
| Visibility is fail-closed | `visibleTo` admits only who it names; no role ⇒ sees only tools that declare none |
| Visibility is input-independent | a predicate audience takes `McpCaller` and nothing else — arguments are out of reach |
| `tools/list` is per connection | filtered per caller on every call, never a static catalog |
| Gate order | visibility → scope → arguments → policy; the scope gate never waits on a policy run against attacker-supplied input |
| Every outcome is audited | one line per `tools/call`; hidden/scope/policy at `warn`, ok at `info` — see `audit.ts` |
| Audit lines carry no payload | tool, outcome, actor, code. Never arguments, never rows |
| No trusted-tool mode | there is no flag that skips policy evaluation |

Executable contract: `security.test.ts`. Rationale: [`docs/architecture/11-ai-surface.md`](../../docs/architecture/11-ai-surface.md).

## Their apps are AI-first too

A generated app exposes its own MCP surface with one call, so the user's agents can drive the
user's app:

```ts
// apps/admin/src/mcp.ts
import { defineAppMcp } from '@ultimat3/mcp';

export const mcp = defineAppMcp({
  name: 'acme-admin',
  include: 'exposed',                    // every action/query with mcp: { expose: true }
  resources: [orgExport],
  prompts: ['apps/web/app/posts/prompts/summarize.v3.md'],
  tools: {
    seatReport: {                        // the key IS the tool name
      description: 'Seats used, remaining and the plan limit. Read-only.',
      input: t.object({}),               // any Standard Schema
      policy: 'org:administer',          // an existing permission, never a new rule
      destructive: false,
      async handle({ ctx }) {
        return seats(await ctx.orgs.byId(ctx.actor.orgId));
      },
    },
  },
  resolveToken: (token) => sessions.resolveAgentToken(token),
});

// app.config.ts
routes: [mcp.route]                      // POST /mcp, rate-limited per method class
```

`include: 'exposed'` reads the action and query registries instead of asking for
`actions: [...]` / `queries: [...]` — the registries already know who opted in, and a
second hand-maintained list is a thing that goes stale silently. The explicit arrays still
work and win over the registry's copy of the same name.

The two lists are read differently, on purpose. `include` **sweeps**: it holds every primitive
the app registered, so one that never opted in is passed over. `actions:`/`queries:` are
**written out**: naming a primitive there is the request to expose it, so one that never declared
`mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot — a listed tool is never silently
missing from the catalog, and exposure stays declared next to the policy. Two primitives reaching
one tool name is `X_MCP_TOOL_DUPLICATE`, also at boot.

A hand-written tool's `policy` is a permission, evaluated through the same `guard()` an
HTTP request goes through, so a tool cannot acquire a second authz path. A tool without one
is `X_MCP_TOOL_UNSAFE` at boot, and an unmarked tool is metered as a write.

## Transports

| Transport | Entry | Auth |
|---|---|---|
| HTTP | `mcpHttpRoute({ server, resolveToken })` → `POST /mcp` | `Authorization: Bearer <token>` → `Actor { kind: 'agent' }` |
| stdio | `serveStdio({ server, caller })` | none — the peer already owns the shell |

The HTTP transport exports a route *descriptor*, not a mounted handler: `@ultimat3/http`
owns the lifecycle, and the descriptor stays drivable from a bare `Request` in a test. It
carries `rateLimitClass(body)` because all MCP traffic is one URL — a per-route bucket would
charge `initialize` to the write bucket and throttle an agent on its handshake.

Reads: 120/min. Writes: 20/min. Unresolvable calls bill the write bucket (fail-closed).

## Resources

| URI | Contents |
|---|---|
| `ultimate://manifest` | `x.manifest.json` — the generated facts |
| `ultimate://openapi.json` | OpenAPI 3.1 projected from actions and queries |
| `ultimate://routes` | route table |
| `ultimate://schema` | entities, columns, invariants |

Providers are injected thunks: `@ultimat3/manifest` and `@ultimat3/render` sit in this same
tier, so the CLI wires them and this package owns only the shape and the URIs.

## Argument validation

`tools/list` hands the agent a JSON Schema, so that document is the thing enforced — there is
no second private validator a tool could be judged against instead. `validate-args.ts`
implements the emitted subset (objects, arrays, enums, `required`, `additionalProperties`,
bounds, `default`) and applies declared defaults. Actions still re-parse authoritatively
inside their own handler.

## Errors

| Code | Meaning |
|---|---|
| `X_MCP_TOOL_UNKNOWN` | no visible tool by that name — absent and role-hidden are one answer |
| `X_MCP_SCOPE_DENIED` | visible, but the connection's token lacks the scope |
| `X_MCP_ARGS_INVALID` | arguments failed the declared schema |
| `X_MCP_PROTOCOL` | malformed envelope, unknown method, bad auth header |
| `X_MCP_QUERY_REJECTED` | `db.query` given anything but one read-only statement |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` aimed at a production or otherwise non-branch database |
