# MCP and AI

The differentiator. Not a chat widget, not an "AI SDK integration" — the framework is built so an agent can read it, drive it, and verify its own work, and so the apps it generates have the same property.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). The MCP registry, wire protocol, dev-tool catalog, read-only SQL guard, and action projection are built, and so are the four that used to be contracted: `llm()` is an action factory ([`packages/ai/src/llm.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/llm.ts)), prompts are versioned, `postgresVectorStore()` fuses pgvector cosine with Postgres FTS via RRF, and evals gate on a committed baseline inside `x verify`'s `eval` step.

## Built-in MCP dev server

`x dev` starts an MCP server on the dev socket. Point Claude Code (or any MCP client) at it and the agent stops guessing.

Sixteen tools `As of 2026-09-19` — the whole catalog, spelled exactly as they must be called. No aliases; renaming one is a major.

| Tool | Introspects / does | Replaces the agent's usual guess |
|---|---|---|
| `routes.list` | route table: url, render mode, hydrate, offline, budget | grepping a router directory |
| `schema.describe` | entities with columns, types and invariants | reading migration files in order |
| `policies.list` | every `policy`: permission, subject, where it is enforced | "is this endpoint protected?" |
| `actions.describe` | every action **and query**: input/output schema, policy, cache tags, MCP exposure | reading `api/` by hand |
| `jobs.inspect` | job definitions, retry policy and steps; omit `name` for all | reading `jobs.ts` and guessing the retry |
| `queue.depth` | pending, running and failed counts per queue | tailing a worker to see if it keeps up |
| `manifest.read` | the whole `x.manifest.json`, as text | ten separate reads |
| `errors.explain` | `X_*` code → cause, exact fix command, docs URL | web search |
| `db.query` | **read-only** SQL, 100-row default and 1000-row maximum, `EXPLAIN` on request | inventing a query and hoping |
| `db.migrate` | apply pending migrations **in a branch DB only** | mutating the dev database |
| `tests.run` | run the suite or a substring filter, structured results | parsing terminal output |
| `verify.run` | the whole gate; `fix: true` applies safe autofixes | guessing whether the work is shippable |
| `logs.tail` | last N structured log lines, filterable by runtime role | scrollback archaeology |
| `ui.shot` | photograph one route at a named viewport (`phone`/`tablet`/`desktop`, or `width`+`height`) in `light` or `dark` (`theme`: `prefers-color-scheme` is emulated **and** the scheme is stored as the visitor's choice under `THEME_STORAGE_KEY` before navigation, so an app with `theme.defaultMode: 'dark'` still captures light when asked — `As of 2026-09-19`), against the running `x dev`; returns the PNG **path** and the same verdict `x shot` writes — console, page errors, refused requests, whether every island mounted. Refuses a route with no `budget.js` | a hand-written puppeteer script, and a picture nobody judged |
| `ui.island` | `x shot --island <name> [--state]` as a tool: every declared state photographed and judged | the same, per component |
| `ui.inspect` | DOM, computed-style and accessibility facts for up to 20 selectors in **one** navigation of a route: per match the tag, text (≤200 chars), box, visibility, attributes (≤20), the computed `styles` you name (≤32, kebab-case; the rest land in `droppedStyles`) and with `a11y: true` the browser-computed role and name; plus `title`, `data-theme`, the focused element, the island count, console and page errors. ≤25 matches per selector, 64 KB on the wire (matches are dropped from the LAST selectors first, `truncated: true`); an unparsable selector answers `valid: false`. Takes the same PNG and verdict as `ui.shot` under `inspect/`; same budget gate, same `theme` semantics (the reported `data-theme` is the one asked for, on a dark-default app too) | `page.evaluate` scripts written per question, and a browser launched per question |
| `ui.interact` | drive one route through at most 12 steps — `{click}`, `{type: {selector, text}}` (≤500 chars), `{press}` (a key chord), `{focus}`, `{wait: ms ≤ 5000 \| selector}` (waited visible) — then photograph it (`fullPage` defaults to **false**: a dialog is judged on the fold) and, with an `inspect` block, read the same facts `ui.inspect` reads, in **one** navigation. Same `theme` semantics as `ui.shot`. After every step the islands settle again and one poll interval passes for the CSS transition; per step you get `{ index, kind, ms, navigated, url }`. Refuses whole, never trims: a list over the bounds (`X_UI_INTERACT_STEPS_INVALID`), typing into `<input type="password">` before any keystroke (`X_UI_INTERACT_SECRET_FIELD`), a step that leaves the dev server's origin (`X_UI_INTERACT_LEFT_APP`; a same-origin navigation is allowed and reported `navigated: true`), a step the driver refused (`X_UI_INTERACT_STEP_FAILED`, `meta.step` names it). PNG and verdict under `interact-<hash of the steps>/`, never over `ui.shot`'s; `ok` is the verdict's, except that a navigation a step caused is not the redirect the verdict fails a capture for | a puppeteer script per scene, and a picture of the closed state |
| `ui.diff` | compare two PNGs the other `ui.*` tools wrote — `before`/`after` relative to the app root and confined to `.x/shot/` (`X_UI_DIFF_PATH_OUTSIDE` otherwise, symlinks resolved) — pixel by pixel: `changedPixels`, `changedPercent` (two decimals), `changedBox` (the bounding box, or `null`) and the path of a diff PNG written beside `after` (`diff-<hash8 of before>.png`, or `out`): the `after` capture faded to a quarter over grey, changed pixels solid red. A pixel is changed when any channel moved by more than `threshold × 255` (default `0.1`); no anti-alias detection. Two sizes are `X_UI_DIFF_SIZE_MISMATCH`, a missing file `X_UI_DIFF_FILE_MISSING`. **No browser, no dependency** | a pixelmatch install, or two pictures eyeballed |

| Class | Tools | Exposure |
|---|---|---|
| read | `routes.list`, `schema.describe`, `policies.list`, `actions.describe`, `jobs.inspect`, `queue.depth`, `manifest.read`, `errors.explain`, `ui.diff` | scope `dev:read`, unrestricted in dev — `ui.diff` reads files, and sits here because it reads only `.x/shot/` (resolve + prefix check, symlinks resolved) and launches nothing |
| gated read | `db.query`, `logs.tail` | scope `db:read` / `dev:logs` |
| executes code | `tests.run`, `verify.run`, `ui.shot`, `ui.island`, `ui.inspect`, `ui.interact` | scope `dev:test`; all six declare `destructive: true`, so none is metered as read chatter — the four `ui.*` tools launch a browser |
| write | `db.migrate` | scope `db:migrate`, **branch environments only** |

None of them is exposed in `ROLE=web`. `db.query` accepts one statement, whose leading keyword must be `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — necessary, never sufficient. Batches, any write keyword at statement level (a data-modifying CTE included), locking clauses (`FOR UPDATE`/`FOR SHARE`), `EXPLAIN ANALYZE`, and whole function families matched by prefix of the called name, quoted and schema-qualified spellings included — file access (`pg_read_*`, `pg_ls_*`, `lo_*`, `dblink`), locks (`pg_advisory_*`), session settings (`set_config`), sleeps (`pg_sleep*`), catalog writes (`pg_import_*`) and the functions that run a query handed to them as text (`query_to_xml*`, `cursor_to_xml*`, `table_to_xml*`, `schema_to_xml*`, `database_to_xml*`, `ts_stat`, `ts_rewrite`) — are **refused**, not discouraged — `X_MCP_QUERY_REJECTED`, enforced before the host sees the string. What the scan cannot read is refused, never decoded: a Unicode-escaped quoted identifier (`U&"…"`) is `X_MCP_QUERY_REJECTED` (`As of 2026-10`). A keyword is matched as Postgres lexes an identifier, so a column `set2` is a column, not `SET`. Its Postgres SELECT-only role is conditional on the connection's own rights; the answer's `guards` array names the defences that engaged. `db.migrate` refuses a target that is not a branch database — `X_MCP_NOT_BRANCH_DB`.


### Rate limits on the HTTP transport

**Enforced `As of 2026-08-24`.** `mcpHttpRoute` meters itself, per caller, per class, per minute. It has to: all MCP traffic is one `POST /mcp`, so the HTTP pipeline's own buckets — which key on the route — cannot tell an `initialize` handshake from a migration.

| | Default | Spent by |
|---|---|---|
| `read` | 120 / minute | every method that is not `tools/call`, plus any tool that does not declare `destructive: true` |
| `write` | 20 / minute | a `tools/call` naming a `destructive: true` tool, and **any call this server cannot resolve** — fail-closed, so a probing client never gets the cheap bucket |
| `unauthenticated` | 20 / minute, per **address** | a missing token, or one `resolveToken` answers `null`. Past it the address is refused `429` **before** `resolveToken` runs — a valid guess included, so the answer says nothing about the token (`As of 2026-10`). Keyed on `handle(request, { address })` — the host's resolved client address; a host that passes none is not metered here |

| Rule | Detail |
|---|---|
| Metered after the parse, before the tool | the class comes out of the body, so it cannot move above the JSON parse. An unauthenticated caller is answered `401` four lines earlier and can never spend an actor's allowance |
| The key is the ACTOR | `mcp:<class>\|actor:<id>`, and it never reaches the caller: a 429 is provokable by anyone holding a valid token, so an actor or org id in one is a leak wearing a throttle's clothes |
| Refusal | `X_MCP_RATE_LIMITED`, 429, with `Retry-After`. Its **own** code and not `X_RATE_LIMITED`, because that one's `fix:` names the HTTP pipeline's buckets, which do not govern this route — a fix line that runs and changes nothing is worse than none |
| The knob | `mcpHttpRoute({ rateLimits: { read, write, unauthenticated } })`, or `defineAppMcp({ rateLimits })` |
| Behind N replicas | pass `rateLimitStore: postgresRateLimitStore({ executor })` as well. The default is a per-process memory store — honest for `x mcp serve`, and a lie for N replicas behind one URL, each enforcing the full allowance on its own |


## Every action is an MCP tool

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration. From the existing declaration:

| MCP requirement | Source |
|---|---|
| tool name | the action's export name, **verbatim** — `publishPost`, never `publish_post`. The one name `tools/call` accepts, `scopes:` is keyed on, and every published catalog spells. `As of 2026-08`: `openapi.json`'s `x-ultimate.mcpTool` and `describe().mcp.tool` published a snake_case name until then, and an agent that trusted either called a tool the server answers ToolNotFound for |
| JSON Schema for input | the `input` schema (Standard Schema → JSON Schema, via `introspect()`) |
| output schema | `output` — published as the tool's `outputSchema` when its root is an object ([below](#what-a-client-is-told-beyond-the-schema)) |
| description | `mcp.description` |
| title | `mcp.title` — omitted, none is published |
| annotations | derived from the kind, `mcp.annotations` overrides key by key ([below](#what-a-client-is-told-beyond-the-schema)) |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical |
| idempotency | `idempotent: true` adds one optional argument, `idempotencyKey` (string, 1–255), to the tool's `inputSchema`. `tools/call` removes it from the arguments and passes it to `invoke` as the key — the `Idempotency-Key` header's MCP twin, filed under action, caller and key — so a retry with the same key replays the first result and the same key with other arguments is `X_IDEMPOTENCY_CONFLICT`. The action's input never sees it. An argument, not `params._meta`: a model-driven client cannot set `_meta`, and the retry that needs the key is the agent's |
| audit trail | the same OTel span and log line as an HTTP call |

The projected tool's `run` **is** `invoke` — the same entry point the HTTP route calls (`packages/mcp/src/projectable.ts`). Policy runs inside it, so there is nothing to keep in sync. The projection itself adds **no** MCP scope: a second gate hard-coded into the projection would sit in front of the only gate that matters, and the two would eventually disagree. `defineAppMcp`'s `scopes:` map may still attach one from outside — a property of the connection's token, never invented by the projection.

No MCP-specific permission table, no service account with broad rights. Exposure is opt-in; silence exposes nothing.

The user's own agents can therefore operate the user's product — refund an order, re-run an import, publish a post — with the exact permissions that user has in the UI. See [Admin dashboard](Admin-Dashboard) and [Actions](Actions).

### What a client is told beyond the schema

`As of 22.10`, MCP 2025-06-18. Every piece is optional for the app; the defaults come from the
declaration already written.

| Field | Where it comes from | Default |
|---|---|---|
| `initialize` → `instructions` | `defineAppMcp({ instructions })` — a string, or `(caller) => string \| undefined` for per-population advice (the same shape as `surface`) | none sent. A function that throws or answers blank sends none; the handshake still answers |
| tool `title` | `mcp: { title }` on the action/query; `title` on a hand-written tool | none |
| `annotations.readOnlyHint` | the kind | query `true`, action `false` |
| `annotations.destructiveHint` | the kind | action `true` — the spec's own default made explicit: the framework cannot tell an insert from a delete. Declare `false` for an additive write |
| `annotations.idempotentHint` | `idempotent: true` on the action | `false` |
| `annotations.openWorldHint` | `mcp.annotations` only | not published (only the author knows a write sends mail) |
| `outputSchema` | an action's `output` whose root is an object; a query's declared `rows` as `{ rows: [<row>] }` — or the row itself for a `single: true` read, which answers one row or `X_NOT_FOUND` as its route does (`As of 2026-10`) | none — text only |
| `structuredContent` | every successful call of a tool that publishes `outputSchema`: the serialized answer read back (a `Date` is its string). A LIST query's rows sit under `rows`; a `single: true` query's answer is the row object itself, with no wrapper | absent |

```ts
mcp: {
  expose: true,
  description: 'Tag a post. Adds, never removes.',
  title: 'Tag post',
  annotations: { destructiveHint: false },
},
```

An `outputSchema` is **structure only** — `type`, `properties`, `required`, `items`, `enum`,
`const`, `anyOf`. A client validates `structuredContent` against it and refuses the call on a
miss, so a bound, a pattern or `additionalProperties: false` on rows read from the database would
be a promise nothing enforces on the way out. The meta tools publish their own hints:
`list_resources` / `describe_resource` read-only, `manage_resource` a write (it reaches every
grouped tool); `manage_resource` answers the inner tool's `structuredContent` byte for byte.

**What the model reads is compact.** A tool's text block is one-line JSON (the 2-space form until
22.10 spent a third of a large answer on indentation). `list_resources` answers **plain text**, one
line per resource and one per action, each fact said once where it is cheapest (`As of 2026-10`):

| Rule | Rendered |
|---|---|
| a scope every action of a resource shares | once, on the resource line: `(scope posts)` |
| a scope every action of one KIND shares | once, per kind: `(query scope posts:read; action scope posts:write)` |
| any other scope, or an unscoped action among scoped ones | on the action itself: `(scope …)` |
| kind | `(action)` only, from `destructive`; untagged = read-only query — never inferred from the name |
| `confirms: true` | `(confirms)`, always on the action |
| params | every required field, then optional ones to 4 fields / 100 chars, then `…`; an enum past 8 literals ends `\|…` |

```text
2 resource(s). Run one with manage_resource({resource, action, params}); describe_resource({resources:["<name>"]}) has the full input schemas. Untagged = read-only query; (action) may write; (confirms) waits for a human; … = more in describe_resource.

org (scope app:use) — The organisation
  transferOrg (action) {} — Transfer the org

posts (query scope app:use; action scope posts:write) — Blog posts
  listPosts {status_eq?: string|number|boolean, title_cont?: string, sort?: "createdAt"|"-createdAt", …} — Posts, filtered
  publishPost (action; confirms) {postId: string} — Publish a draft post
```

The same catalog as data, for a test: `mcp.server.catalog(caller)` — every action keeps its own
`scope` there. `describe_resource` stays compact JSON with the full schema — a schema is JSON.

**Hold the standing surface to a number.** `tools/list` rides every step and `list_resources` sits
in the transcript all session:

```ts
import { assertMcpSurfaceBudget } from '@ultimat3/mcp';

test('the staff surface stays small', async () => {
  // The derivation beside the number: the size measureMcpSurface reported, × a margin.
  await assertMcpSurfaceBudget(mcp.server, staffCaller, { toolsList: 4_000, listResources: 12_000 });
});
```

`measureMcpSurface(server, caller)` returns `{ toolsList, listResources, instructions }` in
characters, off the wire; the assert refuses every surface over its ceiling in one
`X_MCP_SURFACE_OVER_BUDGET`.

**Refusals speak to the caller.** `defineAppMcp` renders an error's `callerFix` — what a remote
agent can do — where the framework's own `fix` names a command only the app's developer can run:
`X_FORBIDDEN` says to ask the account owner for the permission, not `x policy explain`; a missing
scope says to ask for a token that carries it; an invalid argument says to correct the field
against the published schema. The developer's `fix` stays in the log line, `--json`, and on
`createMcpServer` (the dev server), whose default is `errorAudience: 'developer'`;
`defineAppMcp({ errorAudience: 'developer' })` restores it for an app. **A 5xx cause is the
server's own business** (`As of 2026-10`): for the caller audience, a thrown 5xx code core's
`hasPublicCause` does not list (`X_DB_STATEMENT_FAILED` carries the Postgres message and the
statement) renders a fixed sentence as its `cause` and `x errors explain <code> --json` (or its
`callerFix`) as its `fix` — in a tool result and in a `resources/read` error's `data` alike, the
verdict a production problem document gives. The developer audience keeps both. An app's own error takes the
same two fields, plus `docs`:

```ts
class RefundWindowError extends UltimateError {
  constructor() {
    super({
      code: 'X_FORBIDDEN',
      cause: 'the payment is 142 days old; refunds are limited to 90 days',
      fix: 'x policy explain refund:create --json',
      callerFix: 'issue a credit note instead',
      docs: 'docs://recipes/issue-a-credit-note',
    });
  }
}
```

A `docs` other than the framework's one Error-Codes page is a fourth line of the tool result —
`  docs:  docs://recipes/issue-a-credit-note` — and is the `docs` member of the problem document
over HTTP. A production problem document carries `callerFix` as its `fix`; a dev one keeps the
developer's.

### The app's own endpoint is mounted by the web role

`As of 2026-09-05`. `defineAppMcp({ …, resolveToken })` builds `mcp.route`, and `app.config.ts`
declares `ai: { mcp: { expose: true } }` **by default** (the path is `defineAppMcp`'s own, `/mcp` by default) — and until this date nothing
between the two served it: `POST /mcp` was `X_ROUTE_NOT_FOUND` under `x dev` and in every
container. The contract is one file:

| Piece | Where | Rule |
|---|---|---|
| the declaration | `apps/<app>/mcp.ts` | `export const mcp = defineAppMcp({ include: 'exposed', resolveToken })` |
| the switch and the path | `app.config.ts` → `ai.mcp` | `expose` (default `true`), `path` (default `/mcp`) |
| the mount | `x dev` **and** `runRole`, through one call | `POST <path>` → `mcp.route.handle(request)`; the boot log says `app mcp mounted`, `x dev`'s summary prints `mcp POST /mcp` |
| auth | the route's own | `auth: 'public'`, `enforcedBy: 'handler'` on the http route — the bearer token is read by `resolveToken`, never pre-judged by the pipeline |
| exposed and unmountable | `X_MCP_APP_UNMOUNTED`, logged once | no file exports `mcp`, or it was built without `resolveToken` (no `route`); the fix names the file to write |

#### Several endpoints, one per population

`As of Unreleased`. `mcp` may be a non-empty **array** of `defineAppMcp` values — one endpoint per
population, each with its own catalog, `instructions`, `groups`, `scopes` and `oauth`. Same export
name, same file; the order is the contract:

```ts
// apps/web/mcp.ts
export const mcp = [
  defineAppMcp({ name: 'notificado', include: 'exposed', scopes: CUSTOMER_SCOPES, resolveToken: customerToken, oauth }),
  defineAppMcp({ name: 'notificado-admin', path: '/mcp/admin', tools: staffTools, surface: 'meta', groups, scopes: STAFF_SCOPES, resolveToken: staffToken, oauth }),
  defineAppMcp({ name: 'notificado-afiliados', path: '/mcp/afiliados', tools: affiliateTools, scopes: AFFILIATE_SCOPES, resolveToken: affiliateToken, oauth }),
];
```

| Rule | Detail |
|---|---|
| endpoint #0 | mounts at its own `defineAppMcp({ path })` (default `/mcp`), exactly as a single export does, and owns the root `/.well-known/oauth-protected-resource` |
| every other endpoint | mounts at its own `defineAppMcp({ path })` (default `/mcp`), route name `mcp:<path>` |
| isolation | each endpoint is its own `McpServer`: a tool, resource or prompt of one is absent from another's `tools/list` and answers `-32601` there |
| two endpoints on one route | `X_MCP_PATH_DUPLICATE`, **thrown** at boot — a second endpoint that forgot `path` collides with the default `/mcp` |
| one endpoint without `resolveToken` | `X_MCP_APP_UNMOUNTED` names it; the others still mount |
| boot report | one `app mcp mounted` log line and one `mcp POST <path>` summary line per endpoint; `x dev --json` carries `mcp` (endpoint #0) and `mcpPaths` (all) |

The same discovery serves an app's `RuntimeOverrides`: `apps/<app>/runtime.ts` exporting `runtime`
reaches `x dev` (its middleware, rate-limit store and plain `routes`) and `runRole` when
`apps/web/server.ts` passes none — one middleware chain in development and in the container, not two.
`runtime.routes` (`As of 22.6.0`) is the one escape hatch for a URL no primitive projects to and a
wire format none speaks — an OAuth token endpoint answering RFC 6749 JSON to a form-encoded POST —
mounted after the framework's routes and before the pages, through the whole pipeline.

### OAuth discovery for remote connectors

`defineAppMcp({ oauth })` makes the endpoint an OAuth 2.1 protected resource per the MCP
authorization spec (2025-06-18; unchanged in 2025-11-25) and RFC 9728 (`As of 22.6.0`):

```ts
export const mcp = defineAppMcp({
  include: 'exposed',
  scopes: MCP_SCOPES,
  resolveToken,
  oauth: {
    authorizationServers: ['https://www.example.com'], // issuer(s); https, or http on localhost
    resourceName: 'Example',
    // resource: 'https://www.example.com/mcp',   // omitted: the request's PUBLIC origin + path
    // scopesSupported: [...],                     // omitted: Object.keys(scopes)
  },
});
```

| What | Answer |
|---|---|
| 401 (no token) | `WWW-Authenticate: Bearer realm="ultimate-mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` |
| 401 (token did not resolve) | the same plus `error="invalid_token"` |
| `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` | `{ resource, authorization_servers, bearer_methods_supported: ['header'], scopes_supported, resource_name }`, public, `access-control-allow-origin: *` — mounted by both boots beside `POST /mcp` |
| several endpoints | each serves its own path-inserted document (RFC 9728 §3.1) — `/.well-known/oauth-protected-resource/mcp/admin` for `POST /mcp/admin` — with its own `resource` and `scopes_supported`, and its 401 names that document; the root document stays endpoint #0's |
| origin | `ctx.https` + host as the pipeline resolved them, so a TLS-terminating ingress yields `https://…` |

The authorization server (`/.well-known/oauth-authorization-server`, `/oauth/authorize`,
`/oauth/token`) is the app's: consent is a page, and the endpoints whose wire format RFC 6749/8414
fixes are plain routes from `apps/<app>/runtime.ts` → `runtime.routes`. Without `oauth`, the 401 is
`Bearer realm="ultimate-mcp"` as before. Bad block: `X_MCP_OAUTH_INVALID` at definition.

## Three outcomes, deliberately different

Role, scope and policy refuse in three distinguishable ways. The difference is the security property, not an implementation detail.

| Situation | Response | Wire |
|---|---|---|
| The actor's role can never invoke the tool | absent from `tools/list`; a direct call answers ToolNotFound | JSON-RPC `-32601`, message `tool not found: <name> — call tools/list to read the catalog this caller may use`, no `data` at all. The hint is the same sentence on both branches — absent and hidden — so it instructs without saying which |
| The role could invoke it, but the connection's scope does not include it | explicit refusal naming the missing scope | JSON-RPC `-32600`, `data: { code: 'X_MCP_SCOPE_DENIED', scope, fix }` |
| The tool was invoked and the policy denied this input | `X_FORBIDDEN` with the denial reason | a normal `result` with `isError: true` — identical to the HTTP answer for the same call |
| The caller may see and call it, and the arguments fail its published schema | `X_INPUT_INVALID`, each issue addressed by path | a normal `result` with `isError: true` (`As of 22.10`; a `-32602` until then, which clients hide from the model). `-32602` remains for a call that is not one — no `params`, a non-string `name` |

Hidden means hidden: `Forbidden` on a hidden tool is an enumeration oracle — an agent, or an attacker driving one, walks a name list and reads the org's feature set, entity names and internal operations off the difference between "not found" and "forbidden". A scope refusal is the opposite case: a well-behaved client can legitimately fix it, so hiding it would only strand the caller.

| Rule | Detail |
|---|---|
| `visibleTo` takes two forms | a **role allowlist**, or a **predicate over the caller**. A tool that declares neither is visible to everyone |
| Both forms are **fail-closed** | a role list admits only the roles it names, so a caller whose role is not in it — including a caller with no role at all — is refused; a caller with no role sees only tools that declare no `visibleTo` |
| `tools/list` is per connection | answered per caller, never a static catalog |
| Visibility is input-independent | the predicate takes the caller and nothing else — it structurally cannot read call arguments, so existence cannot be probed by varying them |
| Gate order is fixed | visibility → scope → the policy's actor half → arguments → policy. Scope runs before the policy, so a refusal never depends on evaluating a policy against attacker-supplied input; a caller the policy refuses whatever they send gets the policy's `X_FORBIDDEN` (the tool's `admit`) before their arguments are checked, so an issue list never describes a tool they may not call; the rest of the policy — predicates over the arguments — runs after them |
| Every outcome is audited | one structured log line per `tools/call`: `surface: 'mcp'`, tool name, actor id, outcome. ToolNotFound, scope denials and policy denials log at `warn`, a successful call at `info` — ToolNotFound is `warn` on purpose, because an enumeration attempt is a detectable pattern |
| Audit lines carry no payload | tool name, outcome and error code only — never call arguments, never row data |
| No trusted-tool mode | there is no flag that skips policy evaluation, on any MCP surface |
| The actor cannot exceed the human | the actor is the signed-in user's session; an agent inherits exactly those permissions |

Where the first two outcomes are declared:

| Outcome | Declared | Property |
|---|---|---|
| Hidden (role) | `mcp: { visibleTo: [...] }`, on the action or query itself | `readonly string[]` — a role allowlist. A primitive declares the list form only: a declared fact stays static and serialisable. The predicate form of `McpVisibility` is for a surface that builds its catalog programmatically (`@ultimat3/admin` derives visibility from the actor's admin permissions) and hands `@ultimat3/mcp` a tool directly. Both are fail-closed: an unnamed role — including a caller carrying no role at all — gets ToolNotFound, never Forbidden. A catalog audience, not an authz rule; the primitive's `policy` still decides every call |
| Hidden (prompt) | `visibleTo` on an `McpPrompt` passed to `defineAppMcp({ prompts })` | the same `McpVisibility`, the same fail-closed evaluation: absent from `prompts/list`, and `prompts/get` answers exactly as for a prompt that does not exist (`As of Unreleased`). Resources take the same field |
| Scope | `scopes:` on `defineAppMcp` | `Readonly<Record<string, readonly string[]>>` — scope name → tool names. A capability of the connection's token, so it is declared once per app rather than beside every primitive. A name the catalog does not contain, or one claimed by two scope entries, refuses at boot: `X_MCP_SCOPE_UNKNOWN`, `X_MCP_SCOPE_CONFLICT` |

Rationale for each: [`docs/architecture/11-ai-surface.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/11-ai-surface.md).

## Generated facts, hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift is a `x verify` failure |
| `openapi.json` | **generated** | HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project-specific conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style, <600 lines | never generated, never auto-appended |

LLM-generated context files measurably reduce task success. A model writing "here is what this codebase does" produces confident, plausible, partly-wrong prose, and the next agent treats it as ground truth — errors compound and cannot be distinguished from facts. So: facts come from code (structured, verifiable, regenerated every build), conventions come from a human (short, opinionated, stable). Ultimate never generates prose documentation at runtime, and `x new` scaffolds `AGENTS.md` as a terse human-editable stub, not an essay.

## LLM gateway

One typed entry point for model calls — provider-agnostic, observable, cached, evaluated.

```ts
export const summarize = llm({
  model: 'claude-sonnet-5',
  input:  t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.string.array() }),
  prompt: summarizePrompt,                       // versioned artifact
  cache:  { semantic: { threshold: 0.97, ttl: '7d' } },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: can('post:read'),
});
```

| Feature | Behavior |
|---|---|
| Structured output | `output` schema drives tool-use/JSON mode; a parse failure retries once, then throws `X_LLM_OUTPUT_INVALID` |
| Streaming | `.stream()` on the returned action; policy, budget, cache and span unchanged; the `done` chunk carries the validated value |
| Cost + token accounting | per call, per tenant, per prompt version; exceeding `budget` throws before spending |
| Retries | typed on provider errors; rate limits back off, content refusals do not retry |
| Caching | semantic cache from [Caching and invalidation](Caching-And-Invalidation) |
| Tracing | one OTel span per call with model, tokens, cache hit, prompt version |
| Fallback | ordered provider list per model; the provider that answered is on the span as `llm.provider`, never silent. A refusal names a more capable model for the declaration to adopt — models are never swapped at runtime |
| Money | `Money = { minor, currency }` — never a float → [Money](Money) |

**A stream is the same action over a different transport, with one difference that is forced rather than chosen: there is no repair turn.** The non-streaming call retries once on a parse failure; a stream cannot, because the tokens are already on the reader's screen and a second answer is two answers to one question. So a stream yields **unvalidated** text increments plus one final `done` carrying the value that did satisfy `output`, and a schema disagreement is `X_LLM_STREAM_INVALID` naming the non-streaming call as the fix. A structured schema wants the non-streaming call.

Long or multi-call chains are `job`s with steps, so a model call that fails on step 4 retries step 4 only. See [Jobs and workflows](Jobs-And-Workflows).

## Agents, hives and agent jobs → [Agents](Agents)

`llm()` is one model call. A **tool-using loop** is `agent()`, and it is the same kind of thing — an action factory, not a ninth primitive. Everything the loop needs is a factory over a primitive already in the vocabulary:

| Factory | Over | Gives you |
|---|---|---|
| `llm()` | `action()` | one model call, streamable, semantically cacheable |
| `agent()` | `action()` | the turn loop: real actions as tools, forced structured output, `maxTurns`, a run budget, `ctx.signal`, `onTurn`. **No `.stream()`** |
| `hive()` | `action()` | one action fanned out over many inputs: bounded concurrency, split-order results, three-way `ok`/`failed`/`skipped` member outcomes |
| `agentJob()` | `job()` | an agent as durable, retried, cancellable queue work — `As of 2026-08` the only way an agent reaches a queue |
| `backfill()` | `job()` | the resumable, paced sweep those run over → [Migrations and backfills](Migrations-And-Backfills) |

A tool is a real `action()` carrying `mcp: { expose: true }` — the **same** predicate an external MCP client is filtered by, so an in-app agent and an external one are offered exactly the same catalogue and authorize identically. An `agent()` returns an action, so an agent is a tool of another agent with no supervisor primitive anywhere.

Full reference, including the at-least-once trap that makes every mutating tool's idempotency your obligation: [Agents](Agents).

## Prompts as versioned artifacts

```
apps/web/app/posts/prompts/summarize.v3.md      # the prompt, plain markdown + typed slots
apps/web/app/posts/prompts/summarize.evals.ts   # evals attached to it
```

| Rule | Why |
|---|---|
| A prompt is a file with a version, not a string literal | diffable, reviewable, attributable in traces |
| Editing a prompt requires a version bump | invalidates the semantic cache; keeps A/B honest |
| Slots are typed | a missing variable is a compile error, not a `{{undefined}}` in production |
| **Every prompt has an evals file** — no evals is a `x verify` failure | an unevaluated prompt is untested code |
| Old versions retained | traces stay interpretable; rollback is a config line |

## Vectors and hybrid search

pgvector in the same Postgres. No second datastore.

| Piece | Detail |
|---|---|
| Embeddings | declared on an entity: `embed: { field: 'body', model: 'text-embedding-3-large' }` |
| Backfill | generated as a `job` with steps, resumable, rate-limited per tenant |
| Index | HNSW, created by the generated migration |
| Hybrid search | one `query` primitive fusing pgvector cosine + Postgres FTS with Reciprocal Rank Fusion; weights are config |
| Filtering | tenant + policy filters applied **in SQL**, so vector search cannot leak across tenants; a store with no tenant bound, read inside a request acting for an org, is `X_VECTOR_UNSCOPED` — a backfill opts in with `scope: UNSCOPED` |
| Re-embed | content-hash change triggers a job; unchanged text is never re-embedded |

## Evals as a test type

`eval` is one of the six test types in [Testing](Testing).

| Aspect | Detail |
|---|---|
| Shape | fixture set + assertions: exact, schema, rubric (LLM judge), or regression-vs-baseline |
| Determinism | temperature 0 where possible; judge model and prompt version pinned |
| Gate | `x verify` fails on a score drop beyond the declared tolerance, not on absolute score |
| Cost | reported per run; `x test eval --sample 20` for the fast local loop |
| Output | `--json` with per-case scores, so an agent iterating on a prompt sees which case it broke |

## Branch environments

The shipped surface is `x db branch`, with three verbs. `x branch` (no `db`) is **planned** and exits `X_NOT_IMPLEMENTED`; the build-id and MCP-socket rows below are what it will add.

```bash
x db branch create feat-new-billing --json
x db branch ls --json
x db branch drop feat-new-billing --json
```

| Property | Detail | `As of 2026-08` |
|---|---|---|
| DB | `CREATE DATABASE "<source>_branch_<slug>" TEMPLATE "<source>"` copy-on-write clone — cheap, isolated, disposable. `<slug>` is the name with every character outside `[A-Za-z0-9_]` replaced by `_` — a hyphen is not legal in an unquoted Postgres identifier — so `create feat-new-billing` clones into `myapp_branch_feat_new_billing`. Embedded: a copied `pgdata-<name>` directory, which keeps the name **as typed** | **shipped** |
| Migrations | `db.migrate` applies here, never to the shared dev DB (`X_MCP_NOT_BRANCH_DB`) | **shipped** |
| Preview URL | `http://<name>.localhost:<PORT>`, reported on `data.preview` | **the URL is computed**; nothing routes that subdomain for you |
| Teardown | `x db branch drop <name>` — it may only drop what `ls` shows | **shipped** |
| **Build ID scopes the SW** | a per-branch build id giving the branch its own SW scope and cache namespace, so a preview can never poison prod cache → [PWA and offline](PWA-And-Offline) | **planned**, part of `x branch` |
| Scoped MCP socket | `ws://localhost:9229/<name>` | **planned**, part of `x branch` |
| Agent use | an agent can migrate, seed, test, and browse a preview without risking anything shared | |

## `--json` everywhere

Every command and every error has a machine-readable form. Same content, different encoding.

```
$ x verify --json
{"ok":false,"checks":[{"name":"budgets","ok":false,"failures":[
  {"route":"site/pricing","metric":"js","actual":"61kb","limit":"40kb",
   "cause":"chart.js via shared/ui/button.tsx",
   "fix":"x fix boundary site/pricing/page.tsx"}]}]}
```

| Surface | Machine form |
|---|---|
| CLI | `--json` on every subcommand |
| Errors | `UltimateError` serializes to `{ code, cause, fix, docs }` |
| HTTP errors | same JSON body, same codes |
| Dev overlay | the identical string a terminal shows |
| MCP | tool errors carry the same code + fix |

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_MCP_TOOL_UNKNOWN` | no visible tool answers that name (role-hidden and absent are indistinguishable) | `tools/list` to read the catalog this caller may use |
| `X_INPUT_INVALID` | arguments failed the tool's published `inputSchema` — an `isError` result naming each field (`As of 22.10`) | correct the named fields against `inputSchema` (`tools/list`, or `describe_resource` on the meta surface) and resend |
| `X_MCP_ARGS_INVALID` | not raised on the wire since 22.10 — invalid arguments answer `X_INPUT_INVALID` as a tool result; `McpArgsInvalidError` stays exported | — |
| `X_MCP_SURFACE_OVER_BUDGET` | `assertMcpSurfaceBudget` measured `tools/list`, `list_resources` or `instructions` over the budget declared for them | shorten what it names, group tools behind `surface: 'meta'`, or raise the budget with the measured size and the reason in the same diff |
| `X_MCP_IDEMPOTENCY_KEY_SHADOWED` | an `idempotent: true` action's input declares `idempotencyKey`, the tool argument reserved for the retry key — refused at boot | rename the action's input field |
| `X_MCP_SCOPE_DENIED` | the connection's token does not carry the tool's scope | reconnect with a token whose scopes include the one `cause` names — the app's `resolveToken(token)` is what returns them — or drop that scope from `defineAppMcp({ scopes })`. Scopes are fixed for the life of a connection, so a grant takes effect on the next one. **Not** `x token grant`: that command is `PLANNED` and exits `X_NOT_IMPLEMENTED` |
| `X_MCP_SCOPE_UNKNOWN` | `defineAppMcp`'s `scopes:` names a tool the server does not project | spell the name as one of the tools the server actually projects, or drop it from that `scopes` entry |
| `X_MCP_SCOPE_CONFLICT` | two `scopes:` entries claim the same tool | keep the tool under the single scope a token must hold for it, and remove the other entry |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given one read-only statement | send exactly one **read-only** `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` — a data-modifying CTE is not a read |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` pointed at a database that is not a branch | `x db branch create <name>   # then retry db.migrate` — point the host at the database the create reported (`DATABASE_URL=…/<source>_branch_<slug>`). The target is read from the database's own name, so a shared one can never pass |
| `X_MCP_PROTOCOL` | malformed envelope, a JSON-RPC **batch** (an array — this server answers one request per message and never walks one), or an unsupported method — a client bug, not an authz outcome | send a JSON-RPC 2.0 body, one request per `POST /mcp` (one per line over stdio); the `-32600` carries `data: { code, fix }` naming which |
| `X_MCP_BODY_TOO_LARGE` | one message over `bodyLimitBytes` (HTTP, `413`) or `lineLimitBytes` (stdio) — on a JSON-RPC `-32600` with `data: { code, cause, fix, limit }` | send less in one message, or raise the cap where the route is built: `mcpHttpRoute({ bodyLimitBytes })` / `defineAppMcp({ bodyLimitBytes })` / `serveStdio({ lineLimitBytes })` |
| `X_MCP_RATE_LIMITED` | this caller spent its per-minute allowance for the request's class ([above](#rate-limits-on-the-http-transport)) | wait out the `Retry-After`, or raise it where the route is built: `mcpHttpRoute({ rateLimits })` / `defineAppMcp({ rateLimits })`. Never `X_RATE_LIMITED`'s buckets — they do not govern this route |
| `X_FORBIDDEN` | the action's policy refused this actor — identical to the HTTP denial | over an app's MCP: the caller's fix — ask the account owner or an administrator for the permission; a retry is refused the same way. As the app's developer: `policies.list` for the permission this tool enforces, then grant it to the actor's role in `apps/web/shared/policies.ts` |
| `X_LLM_OUTPUT_INVALID` | model output failed the `output` schema twice | tighten the prompt or widen the schema; bump the prompt version |
| `X_AGENT_TOOL_UNEXPOSED` | an `agent()` lists an action that is not MCP-exposed — refused at **declaration** | add `mcp: { expose: true, description }` to the action, or drop it from `tools` |
| `X_AGENT_MAX_TURNS` | an `agent()` used every turn without answering | tell the template when to stop and answer through the respond tool, then bump its version |
| `X_HIVE_EMPTY` | a `hive()` split into zero members | return at least one member input, or guard the call site |
| `X_NOT_IMPLEMENTED` | a remote driver stub was reached | configure the local/PGlite driver, or wait for the release named in `fix` |

Full list: [Error codes](Error-Codes). CLI surface: [CLI reference](CLI-Reference).

## Rules

- One authz system. An MCP call and an HTTP call reach the same `policy` with the same actor resolution.
- One name. A projected tool is called the primitive's export name, verbatim, in `tools/list`, in `scopes:`, in the LLM tool list, in `openapi.json` and in `describe()`. There is no second spelling to derive.
- Exposure is opt-in per action; the projection carries no scope of its own — `defineAppMcp`'s `scopes:` map may still attach one, from outside the primitive.
- Visibility is fail-closed and computed per connection. A hidden tool answers ToolNotFound, never Forbidden.
- Gate order is visibility → scope → arguments → policy, and every outcome is audited. There is no trusted-tool mode.
- Write tools are branch-scoped. The dev server is never reachable in `ROLE=web`.
- Facts are generated every build; conventions are hand-written and short.
- Never generate prose documentation at runtime.
- Every command and every error has a `--json` form; budgets throw before spending, in `Money`.
- Every prompt is a versioned file with an evals file.

Source: [`packages/mcp/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/mcp/src)
