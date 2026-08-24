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
| 3. Parse | one statement, a read leader, no mutating keyword at statement level, no lock — clause **or** `pg_advisory_*` call — and no call into a banned function family, matched by prefix of the called name — quoted and schema-qualified spellings included — so a new spelling is refused by default and a column sharing a prefix is not; on a form with literals and comments blanked | `readonly-sql.ts` |
| 4. Limits | `SET LOCAL statement_timeout`, a hard 1000-row ceiling (`limit` clamps into it, never past it) and a 256 KiB byte cap | `query-limits.ts` |

The answer carries `guards` — the layers that actually engaged — plus `truncatedBy` and `bytes`.
A layer that could not engage (a managed Postgres that refuses `CREATE ROLE`) is **absent from
the list**, never assumed. Truncation is never silent.

## One authz system, two surfaces

Every `action` with `mcp: { expose: true }` becomes a tool for free, and the tool's `handle`
reaches the **same `invoke`** the HTTP route reaches — the projection's `run` is that call with
`surface: 'mcp'`, nothing more. Policy evaluation lives inside `invoke`. (An action has no `.run`
member; `run` is the projection seam, and a query's half of it is `sourceFor`.)

```
HTTP  POST /api/posts/publish ─┐
                               ├─→ invoke(action, input, { surface, actor }) ─→ policy ─→ handler
MCP   tools/call publishPost  ─┘
```

`mcp: { visibleTo: [...] }` on the action or query travels with the projection too — the only
declaration surface outcome 1 has for a projected tool. Catalog audience, never authz.

The projection itself declares **no `scope`** — a projection cannot know what a token means.
`defineAppMcp`'s `scopes:` map (below) may attach one afterward, as a capability of the
CONNECTION rather than a second gate: it decides before the policy runs and never reads the
input, so the two cannot disagree. There is no MCP-specific authorization code to review
beyond it.

## Security posture: three outcomes, hidden ≠ forbidden

| Refused by | Declared by | Answer | Wire |
|---|---|---|---|
| role | `visibleTo` | omitted from `tools/list`, **ToolNotFound** on call, no `data` | `-32601` |
| scope | `scope` | **Forbidden**, naming the missing scope + a runnable fix | `-32600`, `X_MCP_SCOPE_DENIED` |
| policy | the primitive's own `policy` | `isError` result carrying code/cause/fix | `X_FORBIDDEN` |

Forbidden confirms a tool exists, which turns an authz boundary into a catalog an agent can
enumerate by probing. So a role-hidden tool is indistinguishable from an absent one — even
for a caller holding every scope in the system. A scope refusal is the opposite case: the
caller was already shown the tool and can legitimately fix this, so hiding it would only
strand a well-behaved client.

| Rule | Detail |
|---|---|
| A role list is fail-closed | a `visibleTo` role list admits only the roles it names, so a caller carrying no role matches none of them |
| A predicate audience sees the caller and nothing else | it is handed `McpCaller` — never the call arguments, so two calls with different inputs cannot answer differently. Must return the literal `true`; if it throws, the tool is hidden |
| `tools/list` is answered per caller | filtered on every call against the caller the transport resolved — one per HTTP request, one per stdio connection — never a static catalog |
| Gate order | visibility → scope → arguments → policy; the scope gate never waits on a policy run against attacker-supplied input |
| Every outcome is audited | one line per `tools/call`; hidden/scope/policy at `warn`, ok and invalid-args at `info` — see `audit.ts`. A tool that renders its OWN `isError` result may name the code it refused with (`McpToolResult.code`, audit-only, never on the wire) and is then classified by the same `outcomeForCode` a thrown error is — otherwise every self-rendered refusal lands in the `policy-denied` bucket a prober's name walk is alerted from |
| Audit lines carry no payload | tool, outcome, actor, code. Never arguments, never rows |
| No trusted-tool mode | there is no flag that skips policy evaluation |

Executable contract: `security.test.ts`. Rationale: [`docs/architecture/11-ai-surface.md`](../../docs/architecture/11-ai-surface.md).

## Their apps are AI-first too

A generated app exposes its own MCP surface with one call, so the user's agents can drive the
user's app:

```ts
// apps/admin/src/mcp.ts
import { defineAppMcp, t } from '@ultimat3/mcp';

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
  scopes: { 'admin:seats': ['seatReport'] },   // scope name → tool NAMES, by string
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

Both lists take the primitives themselves, exactly as the app declared them:

```ts
import { publishPost } from '../api/posts';

defineAppMcp({ name: 'postly', actions: [publishPost] });
// X_MCP_TOOL_UNDECLARED unless publishPost declared mcp: { expose: true }
```

One adapter serves both routes, so a written-out primitive runs through the same `invoke` (or
`sourceFor`) the swept one does — the list changes which tools are NAMED, never how one runs.
An action that was never handed to `defineApi` has no export name, and is
`X_ACTION_UNREGISTERED` rather than a tool called `''` that nothing could call.

**The tool name is the export name, verbatim** — `publishPost`, never `publish_post`. This server
answers `tools/call` for that name and no other, so every surface that PUBLISHES a name has to
publish the same one: `action.tool()`, `query.tool()`, `x-ultimate.mcpTool` in `openapi.json`, and
`ActionDescriptor.mcp.tool`. The projection reads `primitive.mcp?.name ?? primitive.name`, so the
export name is the **default** and `mcp.name` is an explicit override — unreachable from `action()`
or `query()`, whose declarations carry no `name` field, and available only to a hand-authored
`ProjectablePrimitive` passed to `defineAppMcp`'s `tools:`. The three action publishers snake_cased
the name `As of 2026-08`, so an agent reading the spec called a tool the catalog never contained and
got ToolNotFound.
`src/cross-surface.test.ts` is what makes a fourth spelling a failing test rather than a note.

A hand-written tool's `policy` is a permission, evaluated through the same `guard()` an
HTTP request goes through, so a tool cannot acquire a second authz path. A tool without one
is `X_MCP_TOOL_UNSAFE` at boot, and an unmarked tool is metered as a write.

`scopes:` (type `McpScopes`, applied through the exported `withScopes`) is outcome 2's
declaration surface: a scope name → the TOOL NAMES it covers, however each one reached the
catalog — a projected action, a projected query, or a key in `tools`. It lives here, not
beside the action, because a scope is a capability of the CONNECTION's token — what
`x token grant <scope>` names — not a fact about the operation; the policy beside the action
stays the only rule that reads the input. A name this server does not project is
`X_MCP_SCOPE_UNKNOWN` at boot; one tool claimed by two scopes is `X_MCP_SCOPE_CONFLICT`.

## Transports

| Transport | Entry | Auth |
|---|---|---|
| HTTP | `mcpHttpRoute({ server, resolveToken })` → `POST /mcp` | `Authorization: Bearer <token>` → `Actor { kind: 'agent' }` |
| stdio | `serveStdio({ server, caller })` | none — the peer already owns the shell |

The HTTP transport exports a route *descriptor*, not a mounted handler: a host owns the lifecycle,
and the descriptor stays drivable from a bare `Request` in a test. It carries
`rateLimitClass(body)` because all MCP traffic is one URL — a per-route bucket would charge
`initialize` to the write bucket and throttle an agent on its handshake.

Reads: 120/min per caller. Writes: 20/min. Unresolvable calls bill the write bucket (fail-closed).

**`handle` enforces those numbers itself, `As of 2026-08-24`** — they were published on the
descriptor and applied by no mount point before that, so the ceiling was really Bun's accept rate.
It cannot be done from outside: `rateLimitClass(body)` takes an already-parsed body and `handle` is
the only thing that parses one. The bucket is `@ultimat3/http`'s, keyed per actor per class; over
the limit is `429` + `Retry-After` + `X_MCP_RATE_LIMITED`.

| Knob | Where | Default |
|---|---|---|
| the numbers | `mcpHttpRoute({ rateLimits })` · `defineAppMcp({ rateLimits })` | `MCP_RATE_LIMITS` |
| where they are counted | `mcpHttpRoute({ rateLimitStore })` · `defineAppMcp({ rateLimitStore })` | a per-**process** memory store — N replicas behind one URL each enforce the full allowance, so a fleet passes `postgresRateLimitStore({ executor })` |

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
| `X_MCP_SCOPE_UNKNOWN` | `defineAppMcp`'s `scopes:` names a tool this server does not project |
| `X_MCP_SCOPE_CONFLICT` | two scopes in `defineAppMcp`'s `scopes:` claim one tool |
| `X_MCP_ARGS_INVALID` | arguments failed the declared schema |
| `X_MCP_PROTOCOL` | malformed envelope, unknown method, bad auth header |
| `X_MCP_QUERY_REJECTED` | `db.query` given anything but one read-only statement |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` aimed at a production or otherwise non-branch database |
| `X_MCP_RESOURCE_DUPLICATE` | two resources claim one `ultimate://` URI — refused at registration, as a duplicate tool name is |
| `X_MCP_RATE_LIMITED` | the caller spent its per-minute allowance for this request's class. Its own code rather than `@ultimat3/http`'s `X_RATE_LIMITED` because the KNOB differs — `rateLimits` on the route, never `rateLimit.buckets` in `app.config.ts` |
