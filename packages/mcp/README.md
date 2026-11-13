# @ultimat3/mcp 🤖

The MCP surface. An agent that can reach this package needs no framework documentation — it
asks instead of guessing.

`bun add @ultimat3/mcp` · guide: [MCP And AI](https://github.com/developerz-ai/ultimate/wiki/MCP-And-AI)

```ts
import { defineAppMcp } from '@ultimat3/mcp';

// every action declaring `mcp: { expose: true }` becomes a tool, under its own policy
defineAppMcp({ include: 'exposed' });
```

## The dev server: `x mcp serve`

| Tool | Scope | Answers |
|---|---|---|
| `routes.list` | `dev:read` | route table — url, render mode, offline strategy, hydrate, budget |
| `schema.describe` | `dev:read` | entities with columns, types, invariants; `{ entity }` narrows to one by name or table |
| `policies.list` | `dev:read` | every policy: permission, subject, enforcement points |
| `actions.describe` | `dev:read` | actions + queries: input/output schema, policy, cache tags, MCP exposure |
| `jobs.inspect` | `dev:read` | job definitions, retry policy, steps (omit `name` for all) |
| `queue.depth` | `dev:read` | pending / running / failed per queue |
| `manifest.read` | `dev:read` | `x.manifest.json` verbatim |
| `errors.explain` | `dev:read` | stable `X_*` code → cause + exact fix command + docs |
| `docs.search` | `dev:read` | `x docs <query> --json` run in process — the installed docs, ranked; an `X_*` code is redirected to `errors.explain` |
| `verify.narrow` | `dev:read` | `{ file }` → the steps `x verify --changed` selects for that file alone and the narrowest commands (`x test --filter`, `x verify --only …`). Runs nothing |
| `graph.query` | `dev:read` | `{ node }` → what a change to a file or primitive reaches (`x impact`'s answer); `{ from, to }` → the chain of edges linking two nodes (`x graph --from --to`). The CLI answers through `DevCapabilities.queryGraph`: the graph is `@ultimat3/manifest`'s |
| `db.query` | `db:read` | **read-only, enforced four ways** — SELECT-only role, `BEGIN READ ONLY`, one-statement parse, 5s/1000-row/256 KiB caps |
| `db.explain` | `db:read` | the plan of ONE `SELECT` / `WITH … SELECT` as `EXPLAIN (FORMAT JSON)`; `analyze: true` executes it inside `db.query`'s role, `BEGIN READ ONLY` and 5 s timeout. `db.query`'s parse runs first (a write in a CTE or after `;` is `X_MCP_QUERY_REJECTED`); a production database is `X_EXPLAIN_PRODUCTION_DATABASE`, `x explain`'s rule |
| `db.migrate` | `db:migrate` | **branch DB only** — refuses production and any non-branch target |
| `tests.run` | `dev:test` | `x test [--filter]` — the shell's runner and environment (executes project code) |
| `verify.run` | `dev:test` | `x verify` — the shippable contract; `only` is `--only` |
| `logs.tail` | `dev:logs` | last N lines, optionally per runtime role |
| `requests.statements` | `dev:logs` | the running `x dev`'s recent requests (or one `requestId`): SQL statement count, repeated statements, N+1 verdicts with their fix — read off its `/_x/timeline` |

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
| Every outcome is audited | one line per `tools/call`; hidden/scope/policy at `warn`, and so is `refused` — a tenant-scoped server's call that named no tenant, refused BEFORE dispatch — while ok, invalid-args, unconfirmed and previewed log at `info` — see `audit.ts`; the same decision reaches `onAudit` after the line. A tool that renders its OWN `isError` result may name the code it refused with (`McpToolResult.code`, audit-only, never on the wire) and is then classified by the same `outcomeForCode` a thrown error is — otherwise every self-rendered refusal lands in the `policy-denied` bucket a prober's name walk is alerted from |
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
and says nothing. `x new` writes that file, so a new app boots `app mcp mounted`: `apps/web/mcp.ts`
over its `@<app>/mcp` catalog, with `resolveToken` taking an `@ultimat3/auth` API key everywhere and
`dev-agent.<role>` under `x dev` alone — and a 401 for anything else.

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
| `list_resources` | PLAIN TEXT (`As of 22.10`; JSON until then): one line per resource, and under it one line per action — `  previewPayoutBatch (action; confirms) {batchId: string, note?: string} — <description>`. Compact by rule, never by a character cut (`As of 2026-10`, #590): a scope every action of a resource shares — or every action of one kind, `query scope payouts:read; action scope payouts:write` — is said once on the resource line, and stays on each action otherwise; only `(action)` is tagged, untagged is a read-only query (from `destructive`, never the name); `oneLineParams` names every required field, then optional ones up to 4 fields / 100 characters, then `…`, and cuts an enum after 8 literals with `\|…`. The same catalog as data: `server.catalog(caller)` (`MetaResource[]`, per-action `scope` intact, `undefined` for a flat caller); the renderer is `renderCatalog` (`meta-catalog-render.ts`). `defineAppMcp({ catalogDetail: 'compact' })` — the app's one choice — keeps the resource lines and puts each resource's actions on ONE line of names grouped by kind tag (`listPosts; action: publishPost (confirms)`), descriptions and hints left to `describe_resource`; refused on a flat-only server (`X_MCP_SURFACE_INVALID`) |
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

### Split by effect: `surface: 'meta-split'`

`As of 2026-10-18`. `manage_resource` runs reads and writes alike, so it cannot carry an honest
`readOnlyHint`, and a directory that refuses a read+write dispatcher refuses it. `'meta-split'`
serves the same catalog pair plus three dispatchers, each running only its own effect class:

| Tool | Runs | Input | Hints |
|---|---|---|---|
| `read_resource` | every query (`destructive: false`) | `{ resource, action, params? }` | `readOnlyHint: true` |
| `write_resource` | actions declaring `mcp: { effect: 'write' }` | `{ resource, action, params? }` | `readOnlyHint: false`, `destructiveHint: true` |
| `delete_resource` | actions declaring `mcp: { effect: 'delete' }` — archive, cancel, delete, an external send, a spend | `{ resource, action, params?, live?, confirmed_by_user }` | `readOnlyHint: false`, `destructiveHint: true` |

```ts
import { action } from '@ultimat3/action';
import { defineAppMcp } from '@ultimat3/mcp';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

// An action declares its effect in the one mcp block; a query declares none.
export const archivePost = action({
  input: t.object({ postId: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: can('post:archive'),
  mcp: { expose: true, description: 'Archive a post', effect: 'delete' },
  handle: () => ({ ok: true }),
});

defineAppMcp({
  include: 'exposed',
  surface: 'meta-split',
  groups: { posts: { description: 'Blog posts', tools: ['archivePost'] } },
});
```

- **No default.** A grouped write without `effect` is `X_MCP_EFFECT_UNDECLARED` at boot, naming
  every one; a read declaring one is `X_MCP_EFFECT_CONFLICT`. A `surface` function is held to this
  once any grouped tool declares an effect; until then its `'meta-split'` answer serves `'meta'`, so
  an app written before the split boots as it did.
- **Wrong dispatcher → `X_MCP_WRONG_TOOL`** (an `isError` result, audited `invalid-args`): the cause
  says `wrong_tool_for_action` and names the tool that runs it (`meta.use_tool`). Nothing ran.
- **`delete_resource`**: `live` absent or `false` answers the framework's preview, which runs nothing —
  `{ preview: true, ran: false, resource, action, params, commit_with: { live: true,
  confirmed_by_user: true } }`, audited `previewed`. An action whose own input declares `live`
  authors its preview instead: it is handed `live: false` and runs. `live: true` runs only with
  `confirmed_by_user: true` (the user approved the change, directly or by authorizing the task);
  anything else is `X_MCP_USER_CONFIRMATION_REQUIRED`, audited `unconfirmed`. Both flags are read
  top-level or from `params` (nested wins) and never handed to an action that does not declare them.
  Neither is `required` by the schema — the dispatcher is the one gate, so a call carrying both only
  inside `params` is read, not refused as `X_INPUT_INVALID` (#798).
- Order: visibility (absent answer) → effect (`X_MCP_WRONG_TOOL`) → scope → arguments → the policy's
  actor half → preview / confirmation → `dispatch`, the flat path — same audit line, same bucket.
- Ungrouped tools (`docs`, `whoami`) stay flat beside the five, exactly as on `'meta'`.

### Per-caller tools: `catalog:` and `runtimeTool()`

`As of 2026-11`. A tool that exists per tenant — a connector row, a project's integration — is a
`runtimeTool()` answered by `catalog(caller)`, resolved for **every** `tools/list` and `tools/call`
(never cached) and merged with the static tools into one per-request registry, so visibility →
scope → args → admit → confirmation → policy run on it unchanged.

```ts
import { defineAppMcp, runtimeTool } from '@ultimat3/mcp';

interface ConnectorRow {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
}
declare function connectorsOf(orgId: string | undefined): Promise<readonly ConnectorRow[]>;

defineAppMcp({
  catalog: async (caller) => ({
    tools: (await connectorsOf(caller.actor.orgId)).map((row) =>
      runtimeTool({
        name: row.name,
        description: row.description,
        inputSchema: row.schema, // the wire subset, root `type: 'object'` — else refused
        permission: 'connector:call', // a DECLARED permission, borrowed: never its own authz
        destructive: false,
        run: ({ input }) => ({ called: row.name, input }),
      }),
    ),
  }),
});
```

| Rule | Answer |
|---|---|
| only `runtimeTool()` values are served | anything else is `X_MCP_CATALOG_UNRESOLVED` — a hand-built tool would skip the permission |
| `permission` | `can(permission)`: an undeclared one is `X_PERMISSION_UNKNOWN`, an empty one `X_MCP_TOOL_UNSAFE` |
| `inputSchema` | copied into the wire subset or refused whole (`format`, `$ref`, `oneOf`…): published = enforced |
| a name a static tool, a meta tool, `list_tenants` or another runtime tool holds | `X_MCP_CATALOG_TOOL_DUPLICATE` |
| outcome 2 | with `scopes:` declared, `scope` must be one of its keys (else `X_MCP_CATALOG_UNRESOLVED`); without, none |
| visibility | the resolver already answers per caller: no `visibleTo`. Another caller's tool is an absent tool |
| meta surface | `groups` beside `tools` adds resources to `list_resources`; a boot group's name is a duplicate |
| the resolver throws | the request fails: `tools/list` `-32603` + `{ code, fix }`, `tools/call` an `isError` result — every name alike, so no name is an oracle. Never a smaller catalog |
| rate limit | a runtime name is unknown to the pre-dispatch classifier, so it bills the `write` bucket (fail closed) |

### One token across tenants: `tenant:`

`As of 2026-11`. `resolveToken` answers the PERSON (unchanged shape); every `tools/call` names the
tenant it acts in under `tenant.arg`. The step runs first on a call:

1. the arg is read and **stripped** — no tool's schema or handler ever sees it (`X_MCP_TENANT_INVALID`
   at boot for a tool declaring it). Missing or empty: `X_MCP_TENANT_REQUIRED`, whose fix is `list_tenants({})`.
2. `resolve({ person, value })` answers the call's actor, a `kind: 'agent'` — or `null`, which is
   **byte-for-byte the hidden-tool answer**: no 403, no echo of the value. A throw (or a non-agent
   actor) is `X_MCP_TENANT_UNRESOLVED`, never "not a member".
3. that actor IS the caller for every gate, the confirmation, the policy and `ctx.actor.orgId` — so
   the tenancy guards see one org per call — and the audit line carries `tenant`.

`list_tenants` (no arg, no scope) serves `list({ person })`; `tools/list` publishes the arg as a
required string on every other tool.

**`tools/list` is person-scoped, and not a promise.** It names no tenant (MCP's `tools/list` takes
only a `cursor`), so `visibleTo`, `can()` and `catalog` run there as the PERSON. `tools/call` runs
them as the tenant actor, and the call is authoritative:

| a tool | `tools/list` | `tools/call` |
|---|---|---|
| visible to the person, not to the tenant actor | listed | the hidden-tool answer |
| visible only through a tenant role or a tenant's `catalog` row | not listed | runs, when called by name |

A role or a runtime tool an agent must discover per tenant belongs on the person's actor, or in a
tool the agent reads after `list_tenants` (`docs`, `list_resources`).

**What carries into a tenant, and what `resolve` decides** (ruling, 2026-11-09):

| on the call's caller | where it comes from | narrowed per tenant by |
|---|---|---|
| `scopes`, MCP `role` | the TOKEN, unchanged in every tenant — one token, one grant | nothing: a scope the token lacks is `X_MCP_SCOPE_DENIED` in every tenant |
| `actor` — `roles`, `orgId`, everything the policy reads | `resolve`'s answer, which REPLACES the person's: nothing of the person's actor is merged in | `resolve`: answer fewer roles and the policy refuses (`X_FORBIDDEN`) |

So the app's `resolve` may narrow, and is the one place that does. Held by
`tenant-semantics.test.ts`.

**Only `tools/call` names a tenant.** `resources/read`, `resources/list`, `prompts/*` and
`tools/list` run as the PERSON: a `tenant.arg` sent in their params is ignored, `resolve` is never
asked, and a reader sees `caller.tenant === undefined` and no `orgId`. A resource that reads tenant
data therefore fails closed at the entity tenancy guard (`X_TENANCY_ACTOR_ORG_REQUIRED`). Tenant
data an agent must read belongs in a tool, which names its tenant.

```ts
import { agentActor } from '@ultimat3/core';
import { defineAppMcp } from '@ultimat3/mcp';

declare function roleIn(personId: string, project: string): Promise<string | undefined>;
declare function projectsOf(personId: string): Promise<readonly string[]>;

defineAppMcp({
  include: 'exposed',
  tenant: {
    arg: 'project',
    resolve: async ({ person, value }) => {
      const role = await roleIn(person.id, value);
      return role === undefined ? null : agentActor({ id: person.id, orgId: value, roles: [role] });
    },
    list: async ({ person }) => (await projectsOf(person.id)).map((value) => ({ value })),
  },
});
```

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

**A list query answers one bounded page** (`As of 31.7`): its own `.page()`, at most `MAX_WIRE_PAGE_SIZE` (500) rows — fewer under a declared `maxPage` — and 256 KiB of JSON (`QUERY_LIMITS.maxBytes`). A cut answer adds `{ truncated: true, truncatedBy: 'rows' \| 'bytes', nextCursor? }` to `structuredContent` and as a second text block; the agent passes `nextCursor` back as the tool's `_after` argument. An answer that fits is the bare rows, unchanged. A read whose rows carry no `id` is read whole and cut, with no cursor.

A tool's text is **compact JSON** (`jsonResult`; the 2-space form until 22.10). The meta tools
carry their own hints: `list_resources` and `describe_resource` read-only, `manage_resource` a
write; on `'meta-split'`, `read_resource` read-only and the other two destructive.

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

stdio dispatches each line without waiting for the last (at most 16 at once, then up to 64 more queue while the reader reads on; only a full queue stops it): a slow `tools/call` never holds a `ping`, and a `ping` never queues. `notifications/cancelled` aborts the named call's signal — `tool.handle(args, caller, signal)`, `ctx.signal` inside a projected primitive — and the cancelled call — running or still queued — writes no answer. `lineLimitBytes` counts bytes on the raw chunk (characters until 31.7).

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

**Dual-era, `As of 2026-11`** (`protocol-era.ts`). A request whose
`params._meta["io.modelcontextprotocol/protocolVersion"]` is in `MCP_MODERN_VERSIONS` (`2026-07-28`)
is served statelessly: `server/discover`, no `initialize` or `ping`, every result stamped
`resultType: 'complete'` + `_meta` `serverInfo`, lists and reads `ttlMs: 0`, `cacheScope: 'private'`.
No `_meta` version, or one in `MCP_LEGACY_VERSIONS` (`2025-11-25`, `2025-06-18`, `2025-03-26`), is
today's legacy dispatch; `initialize` echoes an offered legacy revision, else `2025-11-25`. Any
other version is `-32022` `X_MCP_PROTOCOL_UNSUPPORTED` with `data: { supported, requested }`.
There is no `MCP_PROTOCOL_VERSION`: name the era, `MCP_MODERN_VERSIONS[0]` or `MCP_LEGACY_VERSIONS`.

| HTTP refusal | Status | Code |
|---|---|---|
| `Origin` present and core's `proveSameOrigin` cannot show it is this app — not `seen.origin` (else the request URL's), not `seen.listed` (`http.cors.origins` on a mounted app) — before `resolveToken`. A DNS-rebound name passes it (Host and Origin agree) | 403 | `X_MCP_ORIGIN_REFUSED` |
| a Host the host does not serve — `x mcp serve` checks loopback and renders `mcpHostRefused(endpoint)` before `handle` | 421 | `X_MCP_HOST_REFUSED` |
| modern request whose `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` is absent or unequal to the body (base64 sentinel decoded) | 400, `-32020` | `X_MCP_HEADER_MISMATCH` |
| a version (header or `_meta`) this server does not serve | 400, `-32022` | `X_MCP_PROTOCOL_UNSUPPORTED` |
| a modern request naming a method not served | 404, `-32601` | — |
| `GET`/`DELETE` on the endpoint (a legacy stream or session) | 405, `Allow: POST` | `@ultimat3/http`'s `X_METHOD_NOT_ALLOWED` — the pipeline's on a mounted app, rendered the same by `x mcp serve` |

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
handed on. What an action or query DID still reaches core's `auditSink` port (`surface: 'mcp'`);
`onAudit` carries what no `AuditRecord` can — the refusals before anything ran.

| `event.kind` | When | Carries |
|---|---|---|
| `tool-call` | every `tools/call` outcome (`ok`, `hidden`, `scope-denied`, `refused`, `policy-denied`, `invalid-args`, `unconfirmed`, `previewed`, `failed`) — `refused` (at `warn`) is the pre-dispatch one: a `tenant:` server's call that named no tenant (`X_MCP_TENANT_REQUIRED`), answered before any tool ran. A `tenant.resolve` that throws or answers a non-agent is `X_MCP_TENANT_UNRESOLVED`, and lands in `failed` | `tool`, `outcome`, `caller`, `scope?`, `code?` |
| `resource-read` | every `resources/read` outcome | `uri`, `outcome`, `caller`, `scope?`, `code?` |
| `auth-refused` | a missing or rejected token, a non-agent actor, an address past its failure allowance, a cross-origin `Origin` (`origin-refused`, before the token is read) — also logged `mcp.auth.<reason>` at `warn`, except `missing-token` at `info` (OAuth discovery opens with one), the line's `address` its network (an IPv6 /64, `addressNetwork`), the event's `facts` the full one | `reason`, `status` (401/403/429), `facts` |

Every event has `at` from the server's `clock`. Never the token, never the arguments. The hook is
not awaited and cannot change an answer: one that throws or rejects is logged once as
`mcp.audit-hook.failed` at `error` (its `code` when it has one, never its message). `tools/list` and
`resources/list` stay silent, as in the log.

### OAuth discovery (RFC 9728)

`defineAppMcp({ oauth: { authorizationServers: ['https://www.example.com'] } })` (`As of 22.6.0`;
MCP authorization spec, `As of 2026-11` served at modern `2026-07-28` and the legacy handshake
revisions `2025-11-25` / `2025-06-18` / `2025-03-26`, discovery not the same in each — RFC 9728
protected-resource metadata is required from `2025-06-18` on; `2025-11-25` made the 401's
`WWW-Authenticate` optional with a `.well-known` fallback (SEP-985) where `2025-06-18` required it;
`2025-03-26` defines none, its discovery being RFC 8414 authorization-server metadata at the
origin): every 401 carries
`WWW-Authenticate: Bearer realm="ultimate-mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource<path>"`
(`error="invalid_token"` when a token was sent), and `route.protectedResource` carries the document
and the two paths it is served at — path-inserted per RFC 9728 §3.1 and the root — which
`@ultimat3/cli` mounts as public `GET`s beside `POST /mcp`. `resource` defaults to the request's
PUBLIC origin (`handle(request, { origin })`, which the boot fills from `ctx.https`) + the mount
path; `scopes_supported` to the `scopes` map's keys. Issuers must be https (http on loopback):
`X_MCP_OAUTH_INVALID`. The authorization server is the app's own routes.

## OAuth: `mcpAuthorizationServer`

`As of 2026-11`. `mcpAuthorizationServer({ issuer, resource, store, consentPath, lifetimes, scopes,
actor, … })` is `@ultimat3/auth`'s `authorizationServer` bound to one endpoint: every grant binds to
`resource` (a request naming none included), `resolveToken` refuses any other, `oauth` is the block
`defineAppMcp({ oauth })` advertises, and each server decision is an `mcp.auth.<event>` line.
Spread `routes` into `runtime.routes`; write one consent page. Every protocol rule is auth's — see
[wiki MCP and AI](https://github.com/developerz-ai/ultimate/wiki/MCP-And-AI#oauth-discovery-for-remote-connectors).

## Human confirmation: `mcpConfirmations`

A factory over `action`, never a ninth primitive: what it returns IS the decision action
(`{ id, decision: 'approve' | 'reject' }`), registered like any other — route, OpenAPI, typed client,
`audit: true` if asked — and `defineAppMcp({ confirmations })` gates the named tools with it.

```ts
import { defineAppMcp, mcpConfirmations } from '@ultimat3/mcp';

// apps/web/app/orders/actions/confirm-refunds.ts — register it like any action
export const confirmRefunds = mcpConfirmations({
  tools: ['refundOrder'],
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

**One list, both surfaces.** Calling `mcpConfirmations` also registers its gate by tool name
(`registerToolGate`, `@ultimat3/action`), so the same tool waits for a person from
`agent({ tools })` in `@ultimat3/ai`, with no option on the agent to forget. Its arguments are
validated against the tool's published schema first, so one digest covers both; what the schema
refuses is `X_INPUT_INVALID` and opens no row. An approval binds actor, tool and digest, not
surface. Two `mcpConfirmations` on one tool stay legal: each server keeps its own, and **in-app the
first registered answers** (a later one for that name is a no-op). A server handed no
`confirmations`, or handed one for other tools, asks the registered gate per call on every tool it
serves, so forgetting the option is no way around the list. A gated name no exposed action, exposed
query, MCP tool or in-process tool answers to holds nothing, so it is
`X_MCP_CONFIRMATION_TOOL_UNKNOWN` at the `manifest` step. A worker holds a gate only if it
imports the module declaring it, which is `X_ROLE_LOAD_INCOMPLETE` at the `manifest` step otherwise.

The gate binds a tool's **name**, never what it reaches: `inProcessTool({ name: 'refundNow', execute:
() => invoke(refundOrder, …) })` is not gated by `refundOrder`'s row, so list `refundNow` in `tools`.

**Never set `mcp: { expose: true }` on the decision action.** It declares none, which is what makes
`agent({ tools: [decide] })` `X_AGENT_TOOL_UNEXPOSED`. The policy's agent refusal does not reach an
in-app agent, whose actor is the user: exposing the decision action hands that agent its own approval.

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

### Quorum and signed decisions

Two more options on the same factory, `As of 2026-11`: `approvers` (N of M) and `evidence` (every
vote signed). Same gate, same order, same single-use `consume`.

```ts
import type { PgExecutor } from '@ultimat3/core';
import type { McpEvidenceCheck } from '@ultimat3/mcp';
import { mcpConfirmations, postgresConfirmationStore } from '@ultimat3/mcp';

declare const executor: PgExecutor;
// The app's key registry: true only when `signature` verifies over `payload` under a key
// registered to `approver` (a device key — the private half never reaches the server).
declare function verifyDeviceKey(check: McpEvidenceCheck): Promise<boolean>;

export const confirmRefunds = mcpConfirmations({
  tools: ['refundOrder'],
  store: postgresConfirmationStore({ executor }),
  permission: 'order:refund',
  approvers: ({ args }) => ({ quorum: Number(args['amount']) > 1000 ? 2 : 1, from: ['role:finance'] }),
  evidence: { verify: verifyDeviceKey },
  ttlMs: 4 * 3_600_000,
});
```

| Rule | Mechanism |
|---|---|
| the bar | `approvers({ tool, args, actor })` over the VALIDATED arguments, at the call, before a row opens; `quorum` and `from` are stored on the row, so a later declaration cannot lower an open one (the gate re-checks with the higher of the two) |
| `from` | `'role:<name>'` (an application role on the decider) or `'actor:<id>'`, a closed template type. Matched by the decision action's policy — the one authz path — for `approve` and `reject`; `view` stays `permission` + `check` |
| the requester never counts | a decider whose id is the row's `actorId` is `X_FORBIDDEN` (`mcp-confirmation.requester`), and so is an impersonated one (`onBehalfOf`). Only when `approvers` is declared: without it, the original single decision by anyone the policy admits holds |
| one approver, one vote | the store's conditional write refuses a second vote by the same id; the decision answers `X_MCP_CONFIRMATION_QUORUM_PENDING` naming it |
| partial | the row stays `pending` until `quorum` distinct votes; the agent's repeat answers `X_MCP_CONFIRMATION_QUORUM_PENDING` (`n of m`; `meta.outstanding` names the stored selectors still able to vote), nothing runs. One rejection rejects. `ttlMs` expires a partial row like any other |
| refused at the call | a quorum that is not a whole number ≥ 1, an empty or malformed `from`, or more named `actor:` approvers than exist without the requester: `X_MCP_CONFIRMATION_QUORUM_INVALID`, no row. `evidence` with no `verify`: the same code at declaration |
| what is signed | `signingPayload` — `confirmationSigningPayload(row)`, canonical JSON of purpose, confirmation id, tool and the keyed argument digest — returned by `view`. The id makes a signature good for one row (a replay onto the next identical call binds another id); the digest for one set of arguments |
| at the decision | `approve` carries `signature`; missing or not `true` from `verify` is `X_MCP_CONFIRMATION_EVIDENCE_INVALID` and stores no vote. A `verify` that throws propagates: an outage, never a verdict |
| at the call | before the CAS `consume`, the gate runs `verifyConfirmationEvidence` over the STORED row: approved, bound to these arguments, every signature verifying, `quorum` distinct eligible approvers. Any failure consumes the row and answers `X_MCP_CONFIRMATION_EVIDENCE_INVALID` (a denial); a throwing verifier leaves it for a retry |
| a separate process | `verifyConfirmationEvidence(row, { evidence, quorum, from, arguments })` is exported: an executor that trusts nothing the app server wrote re-checks the row with public keys alone. `from` checks `actor:` selectors here; a `role:` standing is the registry's, so `verify` is handed `from` |

The row carries `quorum`, `approvers` and `approvals` (`{ approver, at, signature }[]`, one per
distinct approver, in order); `decidedBy`/`decidedAt` are the vote that met the quorum. The view
answers `quorum`, `approvedBy` and `signingPayload` too. `McpConfirmationStore.decide` takes the
signature as a fifth argument. Three columns are added by the boot (`alter table … add column if
not exists`): a row opened before them reads as one approval, no selectors.

### Where the rows live: the `mcpConfirmationStore` port

A declaration naming no `store` keeps its rows in the `mcpConfirmationStore` port, read at each
use (never when it is built — `runtime.ts` may import it before the boot installs the port): `runtime.ts`'s `mcpConfirmationStore` (installed by the boot before the app's modules
import), else `postgresConfirmationStore` over the app's pool (31.0 — `store` was required before).
`store: memoryConfirmationStore()` still wins, for a test. The interface, `McpConfirmationContestedError`
and the installer (`installConfirmationStore`, boot and `@ultimat3/testing` only) are
`@ultimat3/mcp/adapter`'s; the suite is `@ultimat3/testing/conformance`'s
`mcpConfirmationStoreConformance`.

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

## Long tools: `jobTool()` and `job_status`

`tools: { exportPosts: jobTool({ job, policy, description, result, input?, jobInput?, inlineMs? }) }`
enqueues at once under the caller — `jobInput(input, ctx)` builds the job's input from the tool's
and the caller's (a member id off the request, never an argument) — waits up to `inlineMs`
(default 5,000, ceiling 25,000; also a count of 250 ms polls, so a clock that never moves still
ends it), then answers
`{ status: 'done', result }` — the app's `result` query, run AS the caller — or
`{ status: 'running', jobId, poll: { tool: 'job_status', arguments: { jobId } } }`. One
`job_status` is projected beside any job tool; another actor's, another org's and an unknown id
read the same not-found. A failed job crosses as its code — the code it was THROWN with, read from
the head of the row's `lastError` by `@ultimat3/jobs`' `callerFailure`, `X_INTERNAL` for an uncoded
throw — plus the error's declared `callerFix` when it has one; never the developer `fix` or the row's
text.
A driver without `introspect` is `X_MCP_JOB_TOOL_INVALID`.

## Recipes and the `docs` tool

| Declare | What it does |
|---|---|
| `recipes: [{ name, title, description, steps: [{ tool, why, example? }], notes? }]` | each served as `docs://recipes/<name>` (`text/markdown`) and through a read-only `docs` tool. Every step's tool must be in the catalog (`X_MCP_RECIPE_TOOL_UNKNOWN`), every example must pass its input (`X_MCP_RECIPE_EXAMPLE_INVALID`), at boot, all offenders at once |
| `recipes: await markdownRecipes({ dir })` | one `*.md` per recipe, body served verbatim. Name = file name; `---` `title:` / `description:` frontmatter, else the first `# ` heading and paragraph. A ```` ```call ```` fence — `tool {"arg": "value"}` — is a step, checked like one; a whole `"<name>"` value is a placeholder, any value at boot. A `docs://recipes/` link in the text that names no recipe is `X_MCP_RECIPE_LINK_DANGLING` |
| `extraRecipes: (caller) => recipes` | the caller's own (a tenant's runbooks), asked per request: on `docs` as `source: 'caller'`, on `resources/list` and `resources/read` to that caller alone. Not boot-checked; one naming a tool the caller cannot call is not shown |

`docs({})` lists what this caller can follow; `docs({ name })` / `docs({ uri })` reads one;
`docs({ q })` inlines the best match (3 points a word in name or title, 2 in description, 1 in the
body) and names the nearest names on a miss — never an empty answer while a recipe is visible. A
recipe is visible only when every step's tool is visible to the caller and its scope is on the
token; hidden and unknown are the same not-found. An `UltimateError`'s `docs://recipes/<name>` is
checked at load (`X_MCP_RECIPE_UNKNOWN`). In a contract test, `replayRecipes(server, recipes, {
caller, placeholders })` CALLS every fenced example through the server and reads every link: no
such tool, refused arguments, a refusing policy or a dangling link fails it.

`McpResource.read(caller)` takes the caller the gates admitted, and `mcpServer({ resourceSources })`
lists resources per caller — what `extraRecipes` is built on.

## Consuming another server: `mcpTools()` and `mcpClient()`

| Piece | Rule |
|---|---|
| `mcpTools({ name, url, auth, allow, policy, lock })` | one `action` per allowed remote tool, named `<name>_<tool>`, under the APP's `resource:verb` permission (`policy: 'docs:search'` — a predicate over the remote's input would read nothing), rate limit and confirmation gate. `allow` is required; nothing is discovered at run time |
| `tools.lock.json` | what a person reviewed: per tool, the description, input schema and `readOnly` (a person sets it; `false` keeps the gate binding). `x mcp lock <name>` writes it; `--check` compares. An allowed tool the lock lacks refuses at declaration; a live drift is `X_MCP_REMOTE_TOOL_CHANGED` before the first call, and the `manifest` step of `x verify` runs the check for every declared server (an unreachable server is a warning) |
| `notifications/tools/list_changed` | heard on any response stream, and — for a legacy session — on the `GET` stream the client holds open for the server's own messages (one per session, detached from the request, `listenMs` long, default 5 min, re-opened by the next call; a `405` is a server without one, never asked again; `client.close()` ends it). The next call re-lists and is held to the lock again — a changed tool is refused, never trusted silently |
| output | `{ untrusted, isError }`: the remote's text inside `<untrusted source="mcp:<name>/<tool>">`, middle cut past `maxResultChars`; invisible format characters (`\p{Cf}`) stripped, then every `<` (and full-width `＜`, small `﹤`) written `&lt;` — no tag-shaped pattern left to bypass |
| `expose` | default `false`: the actions are this app's, not its `/mcp`'s — `include: 'exposed'` leaves them out, while an in-app `agent()` is still offered them (`agents: true`). `expose: true` opts one remote server in, making this app's `/mcp` answer for a third party's tools |
| `reverifyMs` | default 3,600,000: one verdict against the live server stands this long (read on `clock`, default `systemClock`), then the next call re-lists and holds it to the lock again — a remote that changes and announces nothing is caught within the hour |
| `mcpClient({ name, url, dial, deadlineMs, auth })` | over core's `outbound()`; modern era first, the legacy handshake when the server refuses it for its era. A text-only result is a success. `X_MCP_REMOTE_REFUSED`'s `meta.failure` tells `transport` / `status` / `rpc` / `malformed` apart; a tool's own `isError` is a result. A 401 is `X_MCP_REMOTE_AUTH_REQUIRED` with `meta.resourceMetadata` |
| `mcpOAuthClient({ clientId, clientName, redirectUri, scopes? })` | the upstream's OAuth: `begin(serverUrl)` reads RFC 9728 then RFC 8414 metadata and answers `{ authorizeUrl, handshake }` (PKCE S256 from `@ultimat3/auth`, `resource` per RFC 8707); `exchange(handshake, { code, state })` and `refresh(handshake, token)` answer `{ accessToken, refreshToken, expiresIn }`. `clientId` is the HTTPS URL this app serves `metadata()` at (a client ID metadata document). Keep the handshake server-side; return the token from `auth` |

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
| `X_MCP_TENANT_REQUIRED` | a call on a `tenant:` server names no tenant (missing or empty `tenant.arg`); refused before dispatch, `list_tenants({})` names the values — `refused`, at `warn` |
| `X_MCP_TENANT_UNRESOLVED` | `tenant.resolve` threw or answered a non-agent actor — never "not a member", which is the hidden-tool answer |
| `X_MCP_TENANT_INVALID` | `tenant.arg` is not a plain name, or a tool's own input already declares it — at boot |
| `X_MCP_IDEMPOTENCY_KEY_SHADOWED` | an idempotent action's input declares `idempotencyKey`, the reserved retry-key argument |
| `X_MCP_PROTOCOL` | malformed envelope, unknown method, bad auth header |
| `X_MCP_PROTOCOL_UNSUPPORTED` | the request names a protocol version this server does not serve (`-32022`, 400) |
| `X_MCP_HEADER_MISMATCH` | a modern HTTP request's mirrored header is absent or disagrees with the body (`-32020`, 400) |
| `X_MCP_ORIGIN_REFUSED` | `Origin` that `proveSameOrigin` cannot show is this app's (nor listed in `http.cors.origins`), refused 403 before the token is read |
| `X_MCP_HOST_REFUSED` | `x mcp serve` was reached on a Host that is not loopback — a DNS-rebound name — 421 |
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
| `X_MCP_CONFIRMATION_QUORUM_PENDING` | some distinct approvers approved and the quorum needs more; also a repeat vote by one who already counted. `meta.outstanding`: `string[]` of the stored `actor:<id>` / `role:<name>` selectors still able to vote — never the requester or an approver who already voted; `[]` when `from` is open |
| `X_MCP_CONFIRMATION_EVIDENCE_INVALID` | under `evidence`, a vote's signature is missing or does not verify, or the stored row no longer proves its approval |
| `X_MCP_CONFIRMATION_QUORUM_INVALID` | `approvers` answered a bar nobody can meet, or `evidence` declares no `verify` |
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
| `McpConfirmationContestedError` | `X_MCP_CONFIRMATION_CONTESTED` | `src/confirmation-errors.ts` — on `@ultimat3/mcp/adapter` only, a store author throws it |
| `McpConfirmationDecidedError` | `X_MCP_CONFIRMATION_DECIDED` | `src/confirmation-errors.ts` |
| `McpConfirmationEvidenceInvalidError` | `X_MCP_CONFIRMATION_EVIDENCE_INVALID` | `src/confirmation-quorum-errors.ts` |
| `McpConfirmationExpiredError` | `X_MCP_CONFIRMATION_EXPIRED` | `src/confirmation-errors.ts` |
| `McpConfirmationPendingError` | `X_MCP_CONFIRMATION_PENDING` | `src/confirmation-errors.ts` |
| `McpConfirmationQuorumInvalidError` | `X_MCP_CONFIRMATION_QUORUM_INVALID` | `src/confirmation-quorum-errors.ts` |
| `McpConfirmationQuorumPendingError` | `X_MCP_CONFIRMATION_QUORUM_PENDING` | `src/confirmation-quorum-errors.ts` |
| `McpConfirmationRejectedError` | `X_MCP_CONFIRMATION_REJECTED` | `src/confirmation-errors.ts` |
| `McpConfirmationToolUnknownError` | `X_MCP_CONFIRMATION_TOOL_UNKNOWN` | `src/confirmation-errors.ts` |
| `McpConfirmationUnknownError` | `X_MCP_CONFIRMATION_UNKNOWN` | `src/confirmation-errors.ts` |
| `McpHeaderMismatchError` | `X_MCP_HEADER_MISMATCH` | `src/errors-transport.ts` |
| `McpHostRefusedError` | `X_MCP_HOST_REFUSED` | `src/errors-transport.ts` |
| `McpOriginRefusedError` | `X_MCP_ORIGIN_REFUSED` | `src/errors-transport.ts` |
| `McpProtocolUnsupportedError` | `X_MCP_PROTOCOL_UNSUPPORTED` | `src/errors-transport.ts` |
| `McpGroupConflictError` | `X_MCP_GROUP_CONFLICT` | `src/meta-errors.ts` |
| `McpGroupUnknownError` | `X_MCP_GROUP_UNKNOWN` | `src/meta-errors.ts` |
| `McpListParamsInvalidError` | `X_MCP_LIST_PARAMS_INVALID` | `src/meta-errors.ts` |
| `McpNotBranchDbError` | `X_MCP_NOT_BRANCH_DB` | `src/errors.ts` |
| `McpProtocolError` | `X_MCP_PROTOCOL` | `src/errors.ts` |
| `McpSurfaceInvalidError` | `X_MCP_SURFACE_INVALID` | `src/meta-errors.ts` |
| `McpQueryRejectedError` | `X_MCP_QUERY_REJECTED` | `src/errors.ts` |
| `McpRateLimitedError` | `X_MCP_RATE_LIMITED` | `src/errors.ts` |
| `McpRemoteAuthRequiredError` | `X_MCP_REMOTE_AUTH_REQUIRED` | `src/remote-errors.ts` — catch it to start `mcpOAuthClient().begin(url)` |
| `McpResourceDuplicateError` | `X_MCP_RESOURCE_DUPLICATE` | `src/errors.ts` |
| `McpScopeConflictError` | `X_MCP_SCOPE_CONFLICT` | `src/errors.ts` |
| `McpScopeDeniedError` | `X_MCP_SCOPE_DENIED` | `src/errors.ts` |
| `McpScopeUncoveredError` | `X_MCP_SCOPE_UNCOVERED` | `src/errors.ts` |
| `McpScopeUnknownError` | `X_MCP_SCOPE_UNKNOWN` | `src/errors.ts` |
| `McpSurfaceOverBudgetError` | `X_MCP_SURFACE_OVER_BUDGET` | `src/errors.ts` |
| `McpTenantInvalidError` | `X_MCP_TENANT_INVALID` | `src/catalog-errors.ts` |
| `McpTenantRequiredError` | `X_MCP_TENANT_REQUIRED` | `src/catalog-errors.ts` |
| `McpTenantUnresolvedError` | `X_MCP_TENANT_UNRESOLVED` | `src/catalog-errors.ts` |
| `McpToolDuplicateError` | `X_MCP_TOOL_DUPLICATE` | `src/errors.ts` |
| `McpToolUndeclaredError` | `X_MCP_TOOL_UNDECLARED` | `src/errors.ts` |
| `McpToolUnknownError` | `X_MCP_TOOL_UNKNOWN` | `src/errors.ts` |
| `McpToolUnsafeError` | `X_MCP_TOOL_UNSAFE` | `src/errors.ts` |
