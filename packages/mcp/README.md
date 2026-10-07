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

**Banned function families** — each is a ban already made elsewhere in another spelling: `pg_notify` (= `NOTIFY`, a write keyword); server control (`pg_cancel_backend`, `pg_terminate_backend`, `pg_reload_*`, `pg_rotate_*`, `pg_switch_*`, `pg_promote`, `pg_wal_replay_*`); replication (`pg_logical_*`, `pg_create_*`, `pg_drop_*`, `pg_replication_*` — advancing a slot is a write no `ROLLBACK` undoes); `pg_file_*`; `txid_current` / `pg_current_xact_id`; `pg_import_*`; SQL run from a string (`*_to_xml*`, `ts_stat`, `ts_rewrite`). `U&"…"` is refused, never decoded; a keyword is a whole identifier (`set2` is a column). Catalog VIEWS (`pg_replication_slots`) are read `from`, never called.

Banned SQL functions are matched as a **prefix of a CALLED function name** — add a family, never a name (`pg_sleep_for` passed an exact `pg_sleep` ban). The unit is the call (`name(`), so a column `pg_sleep_for_seconds` is fine; the call scan keeps quoted-identifier content (`"pg_advisory_lock"(1)` is a call), the keyword scan blanks it. `pg_advisory_*` (a session lock survives layer 2's `ROLLBACK`; `packages/testing/src/db-integration.test.ts`), `pg_sleep*` (the one ban that holds on PGlite), `nextval`/`setval` (a consumed id is not rolled back).

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
| Every outcome is audited | one line per `tools/call`; hidden/scope/policy at `warn`, ok, invalid-args and unconfirmed at `info` — see `audit.ts`; the same decision reaches `onAudit` after the line. A tool that renders its OWN `isError` result may name the code it refused with (`McpToolResult.code`, audit-only, never on the wire) and is then classified by the same `outcomeForCode` a thrown error is — otherwise every self-rendered refusal lands in the `policy-denied` bucket a prober's name walk is alerted from |
| Audit lines carry no payload | tool, outcome, actor, code. Never arguments, never rows |
| No trusted-tool mode | there is no flag that skips policy evaluation |

Executable contract: `security.test.ts`. Rationale: [`docs/architecture/11-ai-surface.md`](../../docs/architecture/11-ai-surface.md).

## Their apps are AI-first too

A generated app exposes its own MCP surface with one call, so the user's agents can drive the
user's app:

```ts
// apps/admin/app/admin/mcp.ts — under app/, so the app scan imports it
import { defineAppMcp, t } from '@ultimat3/mcp';

export const mcp = defineAppMcp({
  name: 'acme-admin',
  include: 'exposed',                    // every action/query with mcp: { expose: true }
  resources: [orgExport],
  prompts: ['apps/web/app/posts/prompts/summarize.v3.md'],   // prompts/get reads the file
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
  scopes: {                              // scope name → tool NAMES; given, it must cover EVERY tool
    'admin:seats': ['seatReport'],
    'posts:write': ['publishPost'],      // …including each one include: 'exposed' projected
  },
  instructions: 'Admin console. seatReport({}) answers seat questions; writes are audited.',
  resolveToken: (token) => sessions.resolveAgentToken(token),
});

```

**The web role mounts it, `As of 2026-09-05` — the contract is the file's location.** `app.config.ts`
has no `routes:` key and never had one; this page said `routes: [mcp.route]` while nothing read it,
and `POST /mcp` answered `X_ROUTE_NOT_FOUND` in every app ever scaffolded. Now: `apps/<app>/mcp.ts`
exports `mcp` (the value `defineAppMcp` returns), and both boots — `x dev` and `runRole` — mount
`POST <defineAppMcp path>` (default `/mcp`) → `mcp.route.handle(request)` when `config.ai.mcp.expose` is `true`,
which is the **default**, and say `app mcp mounted` in the boot log (`x dev` prints `mcp POST /mcp`
in its summary). The http pipeline does not pre-judge the route (`auth: 'public'`,
`enforcedBy: 'handler'`): `mcp.route.handle` reads `Authorization: Bearer` through `resolveToken`
and decides per tool through the policy every other surface evaluates. `expose: true` with nothing
to mount — no file exports `mcp`, or the export was built without `resolveToken` and so carries no
`route` — logs `X_MCP_APP_UNMOUNTED` once, with the file to write; `expose: false` mounts nothing
and says nothing.

**Several endpoints, one per population (Unreleased).** `mcp` may be a non-empty array of
`defineAppMcp` values: every endpoint mounts at its own `defineAppMcp({ path })`; endpoint #0 owns
the root well-known document, and every other serves only its path-inserted metadata document. Each is its own server — catalog, instructions, groups, scopes, prompts. Two on
one route throws `X_MCP_PATH_DUPLICATE` at boot. `McpPrompt.visibleTo` hides a prompt from
`prompts/list` and `prompts/get` with the tool/resource `McpVisibility` semantics.

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
publish the same one: `x-ultimate.mcpTool` in `openapi.json` and `ActionDescriptor.mcp.tool`. The
projection reads `primitive.name` and nothing else — a hand-built `ProjectablePrimitive` names its
tool with its own `name`; the `mcp.name` override, which no `action()` or `query()` could set, is
gone (`As of 25.0.0`). The action publishers snake_cased the name `As of 2026-08`, so an agent
reading the spec called a tool the catalog never contained and got ToolNotFound.

**One projection: `toolFrom`** (`As of 25.0.0`). It takes a real action or query (or a
`ProjectablePrimitive`) and answers the tool this server serves —
`toolListEntry(toolFrom(publishPost))` is, field for field, its `tools/list` entry. Reach for
it where `publishPost.tool()` / `liveFeed.tool()` were: those were a second projection, built a tier
below this one, and they disagreed with the served tool (description fallback, the `idempotencyKey`
argument, annotations). `toolFromQuery` was this function under another name and is gone; ask
`isMcpExposed(primitive.mcp)` from `@ultimat3/core` where `isExposed` was.
`src/cross-surface.test.ts` is what makes a fourth spelling a failing test rather than a note.

A hand-written tool's `policy` is a permission, evaluated through the same `guardAction()` an
HTTP request goes through, so a tool cannot acquire a second authz path. A tool without one
is `X_MCP_TOOL_UNSAFE` at boot, and an unmarked tool is metered as a write.

`scopes:` (type `McpScopes`, applied through the exported `withScopes`) is outcome 2's
declaration surface: a scope name → the TOOL NAMES it covers, however each one reached the
catalog — a projected action, a projected query, or a key in `tools`. It lives here, not
beside the action, because a scope is a capability of the CONNECTION's token — what
`x token grant <scope>` names — not a fact about the operation; the policy beside the action
stays the only rule that reads the input. A name this server does not project is
`X_MCP_SCOPE_UNKNOWN` at boot; one tool claimed by two scopes is `X_MCP_SCOPE_CONFLICT`.

**Given at all, `scopes:` must cover every tool** — `X_MCP_SCOPE_UNCOVERED` at boot names each one
no scope lists, `As of 2026-10`. The registry gates a tool only when it carries a scope, so an
unlisted tool answered every token, while `bearerMount` over the same map serves an unlisted
primitive to nobody; one map now exposes one set on both doors. A ready `McpTool` that arrives with
its own `scope` is covered by it. With `include: 'exposed'`, every primitive that opts in later
needs a line here too, or the next boot says which.

### A constant surface: `surface: 'meta'`

A large or sparsely used catalog blows an agent's context one tool per primitive. `surface: 'meta'`
serves three tools instead, however many primitives sit behind them; tools named in no group
(`docs`, `whoami`) stay flat beside them. The default is `'flat'` and changes nothing.

```ts
import { defineAppMcp } from '@ultimat3/mcp';

defineAppMcp({
  include: 'exposed',
  surface: (caller) => (caller.role?.startsWith('staff') ? 'meta' : 'flat'), // or 'meta'
  groups: {
    payouts: {
      description: 'Affiliate payout batches',
      tools: ['previewPayoutBatch', 'listPayoutBatches'],
    },
  },
});
```

| Tool | Answers |
|---|---|
| `list_resources` | PLAIN TEXT (`As of 22.10`; JSON until then): one line per resource, and under it one line per action — `  previewPayoutBatch (action; confirms) {batchId: string, note?: string} — <description>`. Compact by rule, never by a character cut (`As of 2026-10`, #590): a scope every action of a resource shares — or every action of one kind, `query scope payouts:read; action scope payouts:write` — is said once on the resource line, and stays on each action otherwise; only `(action)` is tagged, untagged is a read-only query (from `destructive`, never the name); `oneLineParams` names every required field, then optional ones up to 4 fields / 100 characters, then `…`, and cuts an enum after 8 literals with `\|…`. The same catalog as data: `server.catalog(caller)` (`MetaResource[]`, per-action `scope` intact, `undefined` for a flat caller); the renderer is `renderCatalog` |
| `describe_resource` | `{ resources: string[] }` (batched) → each action's full `inputSchema` |
| `manage_resource` | `{ resource, action, params }` → the flat tool's answer, byte for byte |

`manage_resource` is the flat `tools/call` through another door: visibility (a hidden or misaddressed
pair answers what an absent one does), then the shared resolver's scope and argument gates, then the
tool's own policy, audited under the tool's name and metered in its bucket. A meta caller cannot call
a grouped tool by name, and a flat caller never sees the meta tools. `confirms: true` on an
`McpTool` marks a write a human finishes. Boot refuses `X_MCP_GROUP_UNKNOWN`,
`X_MCP_GROUP_CONFLICT`, `X_MCP_SURFACE_INVALID` (meta without groups, groups nobody is served) and a
meta tool name taken by an app tool (`X_MCP_TOOL_DUPLICATE`).

**List params.** A list query declares its whitelist, `mcp: { expose: true, listParams: { filters:
{ status: ['_eq', '_in'], createdAt: ['_gt', '_lt'] }, sort: ['createdAt'], fields: ['id', 'status'],
maxLimit: 100 } }`. Keys are FLAT — `status_eq`, `createdAt_gt`, `sort: '-createdAt'`, `fields`,
`cursor` (opaque keyset), `limit` — because a query's input travels as a query string; the query's
own `input` declares them and implements them. `describe_resource` publishes the whitelist and
`manage_resource` admits the whitelist plus the keys the input `required`s and refuses anything
else, an optional input key the whitelist left out included (an `isError` result carrying
`X_INPUT_INVALID`), before the query runs; a
whitelisted key the input does not declare is `X_MCP_LIST_PARAMS_INVALID` at boot.

### What a client is told beyond the schema

`As of 22.10`, MCP 2025-06-18. The projection derives each from the declaration; the primitive's
`mcp` block overrides.

| Field | Source | Default |
|---|---|---|
| `initialize.instructions` | `defineAppMcp({ instructions })` / `mcpServer({ instructions })` — a string, or `(caller) => string \| undefined` | none; a function that throws or answers blank sends none |
| `title` | `mcp: { title }` · hand-written `title` | none |
| `annotations` | `deriveAnnotations(primitive)`, then `mcp: { annotations }` key by key | query `{ readOnlyHint: true }`; action `{ readOnlyHint: false, destructiveHint: true, idempotentHint: <idempotent> }`; `openWorldHint` only when declared |
| `outputSchema` | an action's `output` with an object root; a query's `rows` as `{ rows: [<row>] }`, or as the row itself for a `single: true` read (which answers one row or `X_NOT_FOUND`, as its route does) — `toWireOutputSchema` (from `@ultimat3/schema`) / `toRowsOutputSchema`, structure only (no bounds, patterns or `additionalProperties`: a client refuses a result that misses its schema) | none |
| `structuredContent` | `structuredResult(value, wrap?)`: the serialized answer read back, beside the text block — a list query's rows under `rows`, a `single: true` query's row unwrapped | absent |

A tool's text is **compact JSON** (`jsonResult`; the 2-space form until 22.10). The meta tools
carry their own hints: `list_resources` and `describe_resource` read-only, `manage_resource` a
write.

**Budget test.** `measureMcpSurface(server, caller)` answers `{ toolsList, listResources,
instructions }` in characters, as serialized on the wire; `assertMcpSurfaceBudget(server, caller,
{ toolsList, listResources, instructions })` throws `X_MCP_SURFACE_OVER_BUDGET` naming every
surface over its ceiling. Put the derivation beside the number.

**Whose fix.** `errorAudience: 'caller'` (`defineAppMcp`'s default) renders an error's
`callerFix` — `X_FORBIDDEN`: ask the account owner for the permission; `X_MCP_SCOPE_DENIED`: ask for
a token with the scope; `X_INPUT_INVALID`: correct the named fields — where `fix` names something
only the app's developer can run. `'developer'` (`mcpServer`'s default, the dev server's)
keeps `fix`. An error whose `docs` is not the framework's one Error-Codes page — an app's
`docs://recipes/...` — renders a fourth `docs:` line. Byte-identical to
`UltimateError.format({ audience, docs })`.

## Transports

| Transport | Entry | Auth |
|---|---|---|
| HTTP | `mcpHttpRoute({ server, resolveToken })` → `POST /mcp` — `resolveToken(token, facts)` | `Authorization: Bearer <token>` → `Actor { kind: 'agent' }` |
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

The body is capped WHILE it is read, and over the cap is `413` on a JSON-RPC `-32600` (`id: null`)
carrying `data: { code: 'X_MCP_BODY_TOO_LARGE', cause, fix, limit }` — the stdio transport answers
an over-long line with the same code. A JSON-RPC batch (an array) is refused `-32600` by name with
`data: { code: 'X_MCP_PROTOCOL', fix }`: one request per `POST`, never walked. Every refusal on
this surface carries its instruction, `As of 2026-09-07` — the 413 and the batch were the two that
did not.

| Knob | Where | Default |
|---|---|---|
| the body cap | `mcpHttpRoute({ bodyLimitBytes })` · `defineAppMcp({ bodyLimitBytes })` | `DEFAULT_MCP_BODY_LIMIT_BYTES`, 1 MiB |
| the numbers | `mcpHttpRoute({ rateLimits })` · `defineAppMcp({ rateLimits })` | `MCP_RATE_LIMITS` |
| failed authentications per address | `rateLimits: { unauthenticated }`, keyed on `handle(request, { address })` | `MCP_UNAUTHENTICATED_LIMIT`, 20 / minute; past it the address is `429` before `resolveToken` runs. No `address`, not metered here |
| where they are counted | `mcpHttpRoute({ rateLimitStore })` · `defineAppMcp({ rateLimitStore })` | a per-**process** memory store — N replicas behind one URL each enforce the full allowance, so a fleet passes `postgresRateLimitStore({ executor })` |
| OAuth discovery | `mcpHttpRoute({ oauth })` · `defineAppMcp({ oauth })` | absent: the 401 is `Bearer realm="ultimate-mcp"` |

### What `resolveToken` is told: `McpRequestFacts`

`resolveToken(token, facts)` (`As of 2026-10`) — a second argument a one-argument resolver ignores.
Frozen, typed, never the raw `Headers`, so a token can be bound to a network or refused from a
browser origin without the resolver parsing a header it cannot trust.

| Fact | Source | Absent |
|---|---|---|
| `address` | `handle(request, { address })` — what the HOST resolved (`ctx.ip`: a declared proxy's `x-forwarded-for` per `trustedProxyHops`, else the socket). Never read from a header here | `null` |
| `userAgent` | `User-Agent`, verbatim — a hint, never an identity | `null` |
| `origin` | the `Origin` request header; `'null'` (the string) is an opaque origin, not an absent one | `null` |
| `path` | the URL path, no query string | — |

```ts
import type { McpRequestFacts, ResolvedToken } from '@ultimat3/mcp';
import { defineAppMcp } from '@ultimat3/mcp';

declare const tokens: {
  resolve(token: string, where: { network: string | null }): Promise<ResolvedToken | null>;
};

export const mcp = defineAppMcp({
  include: 'exposed',
  resolveToken: async (token: string, facts: McpRequestFacts) => {
    if (facts.origin !== null) return null; // agents are not browsers — the same 401 as a bad token
    return tokens.resolve(token, { network: facts.address });
  },
});
```

### `onAudit`: the gate's decisions, as data

`mcpServer({ onAudit })` · `defineAppMcp({ onAudit })` — the route reads its server's. One
audit PATH with a second destination: the `mcp.*` log line is written, then the same decision is
handed on. What an action or query DID still reaches core's `setAuditSink` (`surface: 'mcp'`);
`onAudit` carries what no `AuditRecord` can — the refusals before anything ran.

| `event.kind` | When | Carries |
|---|---|---|
| `tool-call` | every `tools/call` outcome (`ok`, `hidden`, `scope-denied`, `policy-denied`, `invalid-args`, `unconfirmed`, `failed`) | `tool`, `outcome`, `caller`, `scope?`, `code?` |
| `resource-read` | every `resources/read` outcome | `uri`, `outcome`, `caller`, `scope?`, `code?` |
| `auth-refused` | a missing or rejected token, a non-agent actor, an address past its failure allowance — also logged `mcp.auth.<reason>` at `warn` | `reason`, `status` (401/403/429), `facts` |

Every event has `at` from the server's `clock`. Never the token, never the arguments. The hook is
not awaited and cannot change an answer: one that throws or rejects is logged once as
`mcp.audit-hook.failed` at `error` (its `code` when it has one, never its message). `tools/list` and
`resources/list` stay silent, as in the log.

### OAuth discovery (RFC 9728)

`defineAppMcp({ oauth: { authorizationServers: ['https://www.example.com'] } })` (`As of 22.6.0`;
MCP authorization spec 2025-06-18, unchanged in 2025-11-25): every 401 carries
`WWW-Authenticate: Bearer realm="ultimate-mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource<path>"`
(`error="invalid_token"` when a token was sent), and `route.protectedResource` carries the document
and the two paths it is served at — path-inserted per RFC 9728 §3.1 and the root — which
`@ultimat3/cli` mounts as public `GET`s beside `POST /mcp`. `resource` defaults to the request's
PUBLIC origin (`handle(request, { origin })`, which the boot fills from `ctx.https`) + the mount
path; `scopes_supported` to the `scopes` map's keys. Issuers must be https (http on loopback):
`X_MCP_OAUTH_INVALID`. The authorization server is the app's own routes.

## Human confirmation: `mcpConfirmations`

A factory over `action`, never a ninth primitive: what it returns IS the decision action
(`{ id, decision: 'approve' | 'reject' }`), registered like any other — route, OpenAPI, typed client,
`audit: true` if asked — and `defineAppMcp({ confirmations })` gates the named tools with it.

```ts
import type { PgExecutor } from '@ultimat3/core';
import { defineAppMcp, mcpConfirmations, postgresConfirmationStore } from '@ultimat3/mcp';

declare const executor: PgExecutor;

// apps/web/app/orders/actions/confirm-refunds.ts — register it like any action
export const confirmRefunds = mcpConfirmations({
  tools: ['refundOrder'],
  store: postgresConfirmationStore({ executor }), // memoryConfirmationStore() in a test
  permission: 'order:refund',
  ttlMs: 600_000, // DEFAULT_MCP_CONFIRMATION_TTL_MS
});

// apps/web/app/mcp.ts
export const mcp = defineAppMcp({ include: 'exposed', confirmations: confirmRefunds });
```

| Step | What happens |
|---|---|
| agent calls `refundOrder` | after visibility → scope → args → the tool's caller-only `admit`, a pending row opens — actor, org, tool, `keyedFingerprint` (HMAC-SHA-256 under the signing secret) of the validated arguments, expiry — and the call answers `X_MCP_CONFIRMATION_PENDING` naming the id. Nothing ran. Repeating it answers the same id |
| a person views it | `confirmRefunds({ id, decision: 'view' })` answers the request exactly as the agent sent it — `{ tool, status, expiresAt, arguments }`, the arguments opened from their seal. Changes nothing |
| a person decides | `confirmRefunds({ id, decision: 'approve', arguments })` with the `arguments` the view returned, or `decision: 'reject'`, over any surface the action projects to. An approval whose arguments' keyed digest is not the row's — none, different, or a row keyed before a secret rotation — is `X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH`, so a swap between the view and the approval decides nothing. Decided once (`X_MCP_CONFIRMATION_DECIDED`), never after expiry (`X_MCP_CONFIRMATION_EXPIRED`) |
| who may view and decide | policy `can(permission, check)`. An agent never may, whatever it holds (`X_FORBIDDEN`). The default `check` is the asking org: `row !== null && row.orgId === (actor.orgId ?? null)` — another tenant's row and an unknown id are one `X_FORBIDDEN`. Crossing tenants is an explicit `check`; with one that admits a missing row, an unknown id is `X_MCP_CONFIRMATION_UNKNOWN` |
| agent repeats the SAME call | approved: it runs once, through the tool's own `handle` — the action's full policy still decides it. Rejected: `X_MCP_CONFIRMATION_REJECTED`, audited as a denial. Past expiry: `X_MCP_CONFIRMATION_EXPIRED`. Each outcome is delivered once; the next identical call asks again |

Bound to the asking actor, the tool and the input digest: other arguments, or another agent, ride
no one's approval. The digest is keyed because the row stores it — an unkeyed hash of `{ accountNumber }` is
brute-forced from a database read. The open row is found by equality on it, key id included, so
after a signing-secret rotation the same call opens a FRESH confirmation: never a mismatch error,
never the old approval. The arguments are stored SEALED (`seal()`, AES-256-GCM under the app's one
master key, purpose `MCP_CONFIRMATION_ARGUMENTS_PURPOSE`), never plaintext at rest — the person
deciding must see what they approve, or a prompt-injected agent describes "$5 to order 17" and sends
another. `sealKeys` points at the key in a test. `SQL_MCP_CONFIRMATIONS_TABLE` is the store's DDL, imported from `@ultimat3/mcp/schema` (its one path — 25.0.0 took it off the barrel); `store.purge(before)` from a
`task` bounds the table. A gated name the server does not project — or `tools: []` — is
`X_MCP_CONFIRMATION_TOOL_UNKNOWN` at boot. The gated tool carries `confirms: true`, which the meta
catalog shows as `(confirms)`.

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

A call that fails it is a **tool result** with `isError: true` — `X_INPUT_INVALID`, the code HTTP
answers for the same input, each issue addressed by path (`input for tool "publishPost" failed
validation: postId: required`) — `As of 22.10`. It was a JSON-RPC `-32602` until then, and clients
surface a protocol error to the human and hide it from the model, which then retried blind.
`-32602` remains for a call that is not one: no `params`, a non-string `name`.

## Idempotency over MCP

An `idempotent: true` action's tool carries one reserved, optional argument,
`MCP_IDEMPOTENCY_KEY_ARG` (`'idempotencyKey'`, string, 1–255), advertised in `tools/list` and held
to that schema here. `tools/call` takes it out of the arguments and hands it to `invoke` as the
idempotency key — what the `Idempotency-Key` header is over HTTP, filed under action, caller and
key — so an agent retrying a timed-out call with the same key gets the first result back:

```json
{ "method": "tools/call", "params": { "name": "sendNotification",
  "arguments": { "caseId": "c1", "idempotencyKey": "7f0c…" } } }
```

The action's own input never sees the key. A non-idempotent tool does not advertise it and refuses
it (`X_INPUT_INVALID`, as an `isError` result). An argument, not `params._meta`: `_meta` is for host metadata and a
model-driven client cannot set it. An idempotent action whose input already names `idempotencyKey`
is `X_MCP_IDEMPOTENCY_KEY_SHADOWED` at boot.

## Errors

| Code | Meaning |
|---|---|
| `X_MCP_TOOL_UNKNOWN` | no visible tool by that name — absent and role-hidden are one answer |
| `X_MCP_SCOPE_DENIED` | visible, but the connection's token lacks the scope |
| `X_MCP_SCOPE_UNKNOWN` | `defineAppMcp`'s `scopes:` names a tool this server does not project |
| `X_MCP_SCOPE_CONFLICT` | two scopes in `defineAppMcp`'s `scopes:` claim one tool |
| `X_MCP_SCOPE_UNCOVERED` | `defineAppMcp` was given `scopes:` and a projected tool is under none of them |
| `X_INPUT_INVALID` | arguments failed the published `inputSchema` — an `isError` result since 22.10 |
| `X_MCP_ARGS_INVALID` | no longer raised on the wire (22.10); `McpArgsInvalidError` stays exported |
| `X_MCP_SURFACE_OVER_BUDGET` | `assertMcpSurfaceBudget` measured a surface over its declared ceiling |
| `X_MCP_IDEMPOTENCY_KEY_SHADOWED` | an idempotent action's input declares `idempotencyKey`, the reserved retry-key argument |
| `X_MCP_PROTOCOL` | malformed envelope, unknown method, bad auth header |
| `X_MCP_QUERY_REJECTED` | `db.query` given anything but one read-only statement |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` aimed at a production or otherwise non-branch database |
| `X_MCP_RESOURCE_DUPLICATE` | two resources claim one `ultimate://` URI — refused at registration, as a duplicate tool name is |
| `X_MCP_GROUP_UNKNOWN` · `X_MCP_GROUP_CONFLICT` | `groups:` names a tool not projected · lists one tool twice |
| `X_MCP_SURFACE_INVALID` | `surface` and `groups` disagree |
| `X_MCP_LIST_PARAMS_INVALID` | `listParams` whitelists a key the tool's input does not declare |
| `X_MCP_CONFIRMATION_PENDING` | a gated call waits for a person: the cause names the confirmation id |
| `X_MCP_CONFIRMATION_EXPIRED` | the confirmation lapsed before the call came back, or before a person decided it |
| `X_MCP_CONFIRMATION_REJECTED` | a person rejected this exact call |
| `X_MCP_CONFIRMATION_DECIDED` | approve/reject on a confirmation already decided |
| `X_MCP_CONFIRMATION_UNKNOWN` | no confirmation has that id |
| `X_MCP_CONFIRMATION_TOOL_UNKNOWN` | `mcpConfirmations({ tools })` names a tool this server does not project, or none |
| `X_MCP_CONFIRMATION_CONTESTED` | identical concurrent calls kept racing one confirmation; retry |
| `X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH` | an approval did not carry the arguments the agent sent (missing, different, or keyed before a rotation) |
| `X_MCP_RATE_LIMITED` | the caller spent its per-minute allowance for this request's class. Its own code rather than `@ultimat3/http`'s `X_RATE_LIMITED` because the KNOB differs — `rateLimits` on the route, never `rateLimit.buckets` in `app.config.ts` |

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `McpAppUnmountedError` | `X_MCP_APP_UNMOUNTED` | `src/errors.ts` |
| `McpArgsInvalidError` | `X_MCP_ARGS_INVALID` | `src/errors.ts` |
| `McpBodyTooLargeError` | `X_MCP_BODY_TOO_LARGE` | `src/errors.ts` |
| `McpIdempotencyKeyShadowedError` | `X_MCP_IDEMPOTENCY_KEY_SHADOWED` | `src/errors.ts` |
| `McpConfirmationArgumentsMismatchError` | `X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH` | `src/confirmation-errors.ts` |
| `McpConfirmationContestedError` | `X_MCP_CONFIRMATION_CONTESTED` | `src/confirmation-errors.ts` |
| `McpConfirmationDecidedError` | `X_MCP_CONFIRMATION_DECIDED` | `src/confirmation-errors.ts` |
| `McpConfirmationExpiredError` | `X_MCP_CONFIRMATION_EXPIRED` | `src/confirmation-errors.ts` |
| `McpConfirmationPendingError` | `X_MCP_CONFIRMATION_PENDING` | `src/confirmation-errors.ts` |
| `McpConfirmationRejectedError` | `X_MCP_CONFIRMATION_REJECTED` | `src/confirmation-errors.ts` |
| `McpConfirmationToolUnknownError` | `X_MCP_CONFIRMATION_TOOL_UNKNOWN` | `src/confirmation-errors.ts` |
| `McpConfirmationUnknownError` | `X_MCP_CONFIRMATION_UNKNOWN` | `src/confirmation-errors.ts` |
| `McpGroupConflictError` | `X_MCP_GROUP_CONFLICT` | `src/meta-errors.ts` |
| `McpGroupUnknownError` | `X_MCP_GROUP_UNKNOWN` | `src/meta-errors.ts` |
| `McpListParamsInvalidError` | `X_MCP_LIST_PARAMS_INVALID` | `src/meta-errors.ts` |
| `McpNotBranchDbError` | `X_MCP_NOT_BRANCH_DB` | `src/errors.ts` |
| `McpProtocolError` | `X_MCP_PROTOCOL` | `src/errors.ts` |
| `McpSurfaceInvalidError` | `X_MCP_SURFACE_INVALID` | `src/meta-errors.ts` |
| `McpQueryRejectedError` | `X_MCP_QUERY_REJECTED` | `src/errors.ts` |
| `McpRateLimitedError` | `X_MCP_RATE_LIMITED` | `src/errors.ts` |
| `McpResourceDuplicateError` | `X_MCP_RESOURCE_DUPLICATE` | `src/errors.ts` |
| `McpScopeConflictError` | `X_MCP_SCOPE_CONFLICT` | `src/errors.ts` |
| `McpScopeDeniedError` | `X_MCP_SCOPE_DENIED` | `src/errors.ts` |
| `McpScopeUncoveredError` | `X_MCP_SCOPE_UNCOVERED` | `src/errors.ts` |
| `McpScopeUnknownError` | `X_MCP_SCOPE_UNKNOWN` | `src/errors.ts` |
| `McpSurfaceOverBudgetError` | `X_MCP_SURFACE_OVER_BUDGET` | `src/errors.ts` |
| `McpToolDuplicateError` | `X_MCP_TOOL_DUPLICATE` | `src/errors.ts` |
| `McpToolUndeclaredError` | `X_MCP_TOOL_UNDECLARED` | `src/errors.ts` |
| `McpToolUnknownError` | `X_MCP_TOOL_UNKNOWN` | `src/errors.ts` |
| `McpToolUnsafeError` | `X_MCP_TOOL_UNSAFE` | `src/errors.ts` |
