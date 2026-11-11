# Actions

The load-bearing primitive. A mutation or command, server-authoritative, declared once.

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: post.orgId });
    return post;
  },
});
```

Declared one per file in a feature's `actions/` (`actions/publish-post.ts`, what `x g` writes). Named export, never default. The export name is the identity, and it must be globally unique. Only the HTTP path is *derived* from it (`publishPost` → `POST /api/posts/publish`); the OpenAPI `operationId` and the **MCP tool name are the export name verbatim** — `publishPost`, never `publish_post`. `As of 2026-08` that holds on every surface at once: what `tools/call` accepts, what `defineAppMcp`'s `scopes:` map is keyed on, what the LLM tool list offers, what `openapi.json`'s `x-ultimate.mcpTool` publishes, and what `describe().mcp.tool` reports.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `input` | Standard Schema (`t` from `@ultimat3/schema`) | yes | parsed before anything else runs; drives the TS type, JSON Schema, OpenAPI request body, MCP tool schema. `t` is the shipped dependency-free builtin provider; ArkType, Zod and Valibot are optional swaps behind `configureSchemaProvider` and ship no adapter |
| `output` | Standard Schema | yes | the response contract; drives the typed client return type and the OpenAPI response. A `.sensitive()` field reachable from it is `X_SCHEMA_SENSITIVE_OUTPUT` at registration: an output is sent back |
| `policy` | `Policy` from `can(...)` | yes | the one authz decision, evaluated on every surface. Omitting it is a build error |
| `cache.invalidates` | `readonly CacheTag[]` | no | tags dropped from every cache tier after `handle` settles — and, for an action invoked inside `withTransaction`, only once the root transaction **commits** (never on rollback). Unknown tag = compile error |
| `mcp.expose` | `boolean` | no (opt-in) | only a literal `true` makes the action a tool; silence exposes nothing. One predicate answers it everywhere — the tool, the LLM tool list, `describe().mcp.expose`, and `openapi.json`'s `x-ultimate.mcpTool` (which is `null` when there is no tool). Listing an un-exposed action in `defineAppMcp` is `X_MCP_TOOL_UNDECLARED` at boot |
| `mcp.description` | `string` | no | the tool description an agent reads, and the OpenAPI `summary`. Contract text, so it stays outside `t()` — `openapi.json` must not depend on a locale. Write it for a stranger |
| `mcp.visibleTo` | `readonly string[]` | no | roles that may see the projected tool; a caller whose role is not named gets ToolNotFound, never Forbidden — the policy still decides every call |
| `rateLimit` | `{ limit: number \| (({ ctx }) => number \| Promise<number>); windowMs: number }` | no | `limit` may be resolved **per call** from `ctx` (the tenant's plan, read by the app), before any bucket is touched; a resolver answering `NaN`, `0`, `Infinity` or a non-number is `X_RATE_LIMIT_INVALID`, never allow-all. A per-call limit publishes as `rateLimit: null` + `rateLimitPerCall: { windowMs }` in `describe()` and `x-ultimate.rateLimit.limit: 'per-call'` in `openapi.json`. Spent **inside `invoke`**, so the HTTP route, the MCP tool, the in-app agent's tool call and `.job()` draw on ONE bucket — the third call to a `limit: 2` action is `X_RATE_LIMITED` whichever surface it came through; a direct in-process call spends nothing. Keyed actor → org → IP; counted in `@ultimat3/http`'s installed store — the `rateLimitStore` adapter port, filled by the boot on every role, `postgresRateLimitStore` unless `apps/<app>/runtime.ts` names one ([Adapters](Adapters#ratelimitstore)). Over HTTP the refusal is `429` + `Retry-After` and `RateLimit-*`, and the route is not also capped by the `default` bucket; the same `toBucket` conversion feeds `openapi.json`, so the published numbers are the enforced ones. `/mcp` additionally buckets by verb class (`MCP_RATE_LIMITS`, read 120/min, write 20/min per token) |
| `meter` | `{ name, period: 'hour' \| 'day' \| 'month', limit, warnAt?, onWarn? }` | no | a durable per-period allowance — see [Usage meters](#usage-meters-meter). Drawn on **every** surface, `server` included, after the policy and before `handle`; spent, `X_METER_EXCEEDED` (429) |
| `idempotent` | `boolean` | no — **required `true` on a `mutator`** | marks the action safe to retry with an `Idempotency-Key` header — over MCP, the tool's optional `idempotencyKey` argument. Inside a transaction the Postgres store settles the record with the write's own `COMMIT`, so a rollback never leaves a `settled` record behind. A field core redacts by name (`apiKey`, `password`, `*Token`…) or a `Secret` is stored as `[redacted]`, and the replay of such an answer is `X_IDEMPOTENT_REPLAY_REDACTED` |
| `http.path` | `string` | no | pins the URL whatever the app's `pathStyle` derives — for a path a caller already holds (`'/api/uploads/signed'`) or a resource-shaped one (`'/orders/:id/refund'`). Lowercase static segments and `:param`s, never `/_x`; each `:param` a REQUIRED `t.string` key of `input:`, else `X_ACTION_HTTP_PATH_INVALID` at registration. The URL's value joins the body before the input is parsed, so the schema, the policy, `row` and the handler read one object; a body naming the key with another value is **400** `X_HTTP_PATH_INPUT_CONFLICT`, never overridden. Under a bearer mount the pin is served at the prefix (`/v1/orders/:id/refund`) — and still at its own path, with the cookie session, as every pin is; the policy decides both. `derivePath(name)` refuses a template; `actionHttpPath(name, { id })` fills it. A `deprecated.replacedBy` naming one is `X_ACTION_DEPRECATION_INVALID`. An inbound webhook is not this door: it is `webhookReceiver()` ([Jobs and workflows](Jobs-And-Workflows#inbound-webhooks)) |
| `http.method` | `'POST'` · `'PUT'` · `'PATCH'` · `'DELETE'` | no — `'POST'` | the verb the pin answers; needs `http.path`. `X_ACTION_PATH_DUPLICATE` keys on method and path, so `PUT /orders/:id` and `DELETE /orders/:id` are two actions. `action.client()` sends it and fills the URL from the input (each value one encoded segment, the key left out of the body); `rpc()` by name cannot see a pin. In `openapi.json`: `{id}`, an `in: path` required parameter, the key gone from the request body, the operation under the declared verb. `x.manifest.json` writes `http: { path, method }` for a pin only; moving it is breaking. `As of 2026-11` |
| `errors` | `readonly string[]` | no — `x g action` writes `errors: []` | the refusals a caller may branch on, each a registered 4xx code listed once (`X_ACTION_ERRORS_INVALID` otherwise, at `action()`). Declared, the list is CLOSED — see [Declared refusals](#declared-refusals-errors). Absent: today's open contract, bytes unchanged. `As of 2026-11` |
| `handle({ input, ctx })` | `(args) => Promise<Output>` | yes | the body. Parsed `input`, ambient `ctx`. Returns `output`-shaped data |

**`.sensitive()` on an input field** — `cardPan: t.string.sensitive()` — means sent in, never
written down by the framework, never sent back (JSON Schema `writeOnly`). Reach, exactly: the
`audit: true` record's `input` and `x jobs show` hold `[redacted]`, read from THIS action's own
schema, so another action's `cardPan` and the idempotency store are untouched. Not your own
`logger.info('x', input)`: that line holds no schema — use `redactKeys` or a `Secret` there.
A refusal's issue carries `rule` (`string.min`, `enum`, … — `SCHEMA_RULES`) and `params`
(`{ min: 3 }`) on the wire, so a form translates on the rule, never the English message.

`ctx` members an action may use:

| Member | Type | Use |
|---|---|---|
| `ctx.actor` | `Actor` | `{ kind: 'user' \| 'service' \| 'agent' \| 'anonymous', id, orgId?, roles, scopes }`. Read-only; authz already ran |
| `ctx.<service>` | app-augmented | repos and services (`ctx.posts`, `ctx.orgs`, `ctx.mail`) — declared via `CtxServices`, registered with `defineService`. On an HTTP request each is built **lazily, on first read, for the authenticated actor**, and rebuilt if the actor, locale or time zone changes (`packages/http/src/request-services.ts`). From 13.0.0 until 21.0.0 they were built before the `auth` stage and acted as the anonymous actor |
| `ctx.jobs` | job client | the facade `<job>.enqueue(input)` resolves; enqueue is transactional via the outbox |
| `ctx.requestId` / `ctx.traceId` | `string` | W3C trace id; the same value crosses HTTP → job → live query |
| `ctx.locale` / `ctx.tz` | `string` | BCP-47 and IANA. Never format a date without `ctx.tz` |
| `ctx.clock` / `ctx.now()` | `Clock` / `Date` | frozen and advanceable in tests. Never `Date.now()` |
| `ctx.logger` | `Logger` | structured, role-tagged, correlated to the span |
| `ctx.signal` | `AbortSignal` | client disconnect / drain / the request deadline; pass it to long calls. A write past the deadline rethrows `X_TIMEOUT` and rolls back; an `idempotent` action called with a key runs to its end instead, on a fresh signal with no deadline, so the retry replays success (`runToCompletion`), under a hard ceiling: twice `requestTimeoutMs` by default (60 s), `configureIdempotency({ scope, ceilingMs })` to change it. Past it the handler is aborted and the key replays `X_IDEMPOTENCY_RUN_CEILING` |
| `ctx.role` / `ctx.buildId` | `Role` / `string` | which runtime role is executing, and which build |

## Usage meters: `meter:`

A meter counts calls per tenant per period, durably, inside `invoke`. Prices, plans and the payment provider stay with the app: the framework resolves a number from `ctx` and counts the draw. `As of 2026-11`.

```ts
import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';

const PER_DAY = new Map([['org-free', 500]]);
const quotaWarning = { enqueue: async () => undefined }; // in an app: a job({ input: MeterWarning, … })

export const callTool = action({
  input: t.object({ prompt: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  rateLimit: { windowMs: 60_000, limit: ({ ctx }) => (ctx.actor.orgId === undefined ? 10 : 60) },
  meter: {
    name: 'calls',
    period: 'day',
    limit: ({ ctx }) => PER_DAY.get(ctx.actor.orgId ?? '') ?? 0,
    warnAt: 0.8,
    onWarn: quotaWarning,
  },
  handle: () => ({ ok: true }),
});
```

| Rule | What happens |
|---|---|
| where | drawn **once per call, inside `invoke`**, on HTTP, MCP, an agent's tool call, `.job()` and an in-process call — after the actor half, the rate limit, the parse and the policy, before `handle`. A call refused by any of those uses none of the allowance |
| whose counter | the tenant (`ctx.actor.orgId`), else the signed-in actor, else one shared `anonymous` counter — refused together, never unlimited. A job run carries its org (`jobRunActor`) |
| period | **UTC** boundaries (`hour`, `day`, `month`); the stored key spells the zone (`day@UTC`), so a zone-aware period added later is a new counter, never a reinterpreted one. Two actions naming one meter with one period share the counter |
| limit | a whole number ≥ 0 (`0` refuses every call), or a function of `{ ctx }`, sync or async, resolved per call — a plan change applies to the next call. Anything else is `X_METER_INVALID` (500), at `action()` for a number, per call for a resolver |
| atomic | one conditional increment: `insert … on conflict … where used + 1 <= limit` in Postgres, a synchronous check-and-add in memory. N parallel calls at the edge admit exactly the remainder |
| retries | an idempotent call draws inside its reservation: a replay — of a success or a settled failure — draws nothing; a refusal releases the key, so the same key runs once the period resets. A non-idempotent retry is a new call and draws again |
| refusal | `X_METER_EXCEEDED`, 429, `meta: { meter, limit, resetsAt, retryAfterSeconds }`; over HTTP `Retry-After` is the seconds to the period's end and the problem document carries `meta: { meter, limit, resetsAt }` — `@ultimat3/http`'s reviewed framework row (`problem-meta-framework.ts`), every other key stays server-side. `retry: 'retry-after'`, so a job waits rather than spending attempts |
| `warnAt` + `onWarn` | both or neither. Crossing `warnAt × limit` claims the period's warning once per tenant (deduplicated across replicas and restarts), then calls `onWarn.enqueue(warning, { outbox: false, tenantId })` — a `job({ input: MeterWarning, … })` satisfies it. An enqueue that fails is logged, never fails the call, and the claim is released for the next draw |
| store | `memoryMeterStore()` by default (`scope: 'process'`, bounded); the CLI boot installs `postgresMeterStore({ executor })` over `x_meter`, one row per tenant × meter × period declaration rolled over in place — bounded by tenants, so it ships no purge. No usage history: an app that bills on usage records its own |
| published | `describe().meter` (`{ name, period, timeZone: 'UTC', limit, warnAt }`, `limit: null` for a resolver), `x-ultimate.meter` in `openapi.json` (absent when undeclared) — with `defineApi({ openapi })`, a 429 naming `X_METER_EXCEEDED` with `Retry-After`, public operation or not — and `actions[].meter` in `x.manifest.json`, the same shape |
| contract diff | breaking when a call pattern the old meter admitted is refused: a meter introduced, a lower limit, a longer period not covering the old one at full use (100/day → month needs ≥ 3,100), a rename (`meta.meter` is on the wire), a move to or from a per-call limit. A shorter period at the same limit admits MORE (100/day → 100/hour): additive, as are a higher limit and a removed meter. `warnAt` is internal. `As of 2026-11` |
| tests | the app preload resets the meter store at every file boundary, as it does the rate-limit store: a test file never resets it itself |

## Streaming: `stream:` and an async generator

An action that answers in pieces declares `stream: <chunk schema>` and writes `handle` as `async *handle({ input, ctx })`: each `yield` is a chunk, the `return` is the output.

| Caller | Gets |
|---|---|
| `accept: text/event-stream` on its route | `event: chunk` per yield (parsed by `stream` first), then one `event: done` (output) or `event: error` (problem document); `x-accel-buffering: no`, a `: keep-alive` every 15 s |
| anything else — JSON, MCP, `.job()`, `.as()`, a direct call | the generator drained, the output alone: one contract |
| refused before the handler starts (policy, input, rate limit) | the ordinary problem response, never a stream |
| the client leaves mid-stream | `ctx.signal` aborts inside the handler |
| a browser | `clientStream({ url, body })` from `@ultimat3/core`: `fetch`, never `EventSource` |

A chunk its schema refuses, or `stream:` beside a handle that is not a generator, is `X_ACTION_STREAM_INVALID`. The OpenAPI 200 lists `text/event-stream` beside `application/json` for a streaming action only. `agent()` streams this way.

## The fluent surface

Every projection this package owns is a method on the action — `publishPost.openapi()`, never `toOpenApiOperation(publishPost)`. The MCP tool is the exception by tier: `@ultimat3/mcp`'s one projection, `toolFrom(publishPost)` (`As of 25.0.0` there is no `.tool()`). Exactly four declared fields are lifted onto it as readable properties: `input`, `output`, `policy`, `mcp`. The rest of the declaration is structured metadata, reachable through `describe()` and nowhere else. An action has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `publishPost(input, options?)` | the mutation | parse `input` → load `row` → evaluate `policy` → `handle` → parse `output` |
| `.as(actor, input, options?)` | the same mutation, as someone else | keeps the surrounding context whole — services, clock, locale, trace — and swaps only the actor. `null` is the signed-out caller |
| `.openapi()` | the OpenAPI 3.1 operation | byte-stable; `x verify` diffs it for contract drift |
| `.client({ baseUrl })` | the typed RPC method | derives `POST /api/posts/publish` by string math, so the browser imports no server code |
| `.job()` | the durable-work handle | the same handler, run through the queue as `action:publishPost` |
| `.contract({ exercise })` | the generated assertions | garbage rejected, anonymous denied, spec present, and the handler run 16 times on generated legal input ([Testing](Testing#the-exercise-assertion)) |
| `.describe()` | the manifest row | `kind`, `name`, `verb`, `resource`, `method`, `path`, `capability`, `input`, `output`, `invalidates`, `idempotent`, `mutator`, `mcp`, `rateLimit` — and the only reader for the declared metadata that is not lifted |
| `.input` `.output` `.policy` `.mcp` | the declaration, lifted | the whole lifted set — readable, and `.mcp` present only when declared. `cache.invalidates`, `rateLimit` and `idempotent` are not properties: read them off `describe()`, where `cache.invalidates` flattens to `invalidates` |

`handle` and `row` — the declaration's two functions — are unreachable by design: neither lifted nor described. The declaration lives in a private store inside `invoke.ts` and `@ultimat3/action` exports no reader for it, so `invoke` is the only thing that can run them — one execution path and one authz path, structurally rather than by convention. A hand-rolled object with `kind: 'action'` is `X_ACTION_FOREIGN`, never a registered action.

Every projection needs the name `defineApi({ actions })` stamps on at boot. It names the export in place, so `import { publishPost }` is the action that projects once the app has booted — there is no second, differently-named twin to remember.

## Six generated artifacts

| # | Artifact | Derived from | Notes |
|---|---|---|---|
| 1 | **HTTP route** | name + `input` | `POST /api/posts/publish` — first word is the verb, the rest is the pluralized resource (the default `pathStyle: 'resource'`); `defineApi({ http: { pathStyle: 'readable' } })` makes it `/api/publish-post`, the kebab-cased name, and `http.path` pins one. Body parsed by `input`, errors are `UltimateError` JSON |
| 2 | **OpenAPI operation** | `input` + `output` + `mcp.description` | `publishPost.openapi()`, emitted into `x.manifest.json` and `openapi.json`; contract diff runs in `x verify` |
| 3 | **Typed client function** | `input` + `output` | one map-wide client, `export const client = rpc<Api['actions']>({ baseUrl })`, then `await client.publishPost({ postId })` in `app/`; or `publishPost.client({ baseUrl })` for a single method. `rpc` is the only name for the map-wide client — no `createClient` alias, no fetch, no codegen step to remember. `x new` writes it as `apps/web/shared/browser-client.ts` (`browserClient`, beside `browserQueries`); it typechecks at any app size (pinned at 300 actions in 100 modules). **`rpc` and `queryClient` do not reach a mount**: under `baseUrl: '…/v1'` they derive `/v1/api/…` and a valid token answers 404. A machine caller uses the mount's OpenAPI document |
| 4 | **Job handle** | the whole declaration | `publishPost.job()` — a namespaced name, an `idempotencyKey` from the payload, and an `invoke` that runs the same handler durably. Register it with the queue; `.enqueue()` belongs to a declared `job` |
| 5 | **MCP tool** | `mcp` + `input` + `policy` | `toolFrom(publishPost)` from `@ultimat3/mcp` — one tool named `publishPost` per exposed action, exactly the `tools/list` entry, JSON Schema from `input`, every call through this action's `invoke` (authz unchanged) |
| 6 | **Test** | `input` + `policy` + `handle` | `publishPost.contract({ exercise })`, handed `apps/web/exercise.ts`'s export, where `x g` declares its entry — schema round-trip, a denial test per policy branch, and the handler on generated legal input, generated green, not as a `TODO` |

**A client for code that cannot import the app.** `rpc` needs the app's action types, so a customer's TypeScript never had one. `x client customer --out <dir>` compiles the committed `openapi.json` (or a bearer mount's own document, `--mount /v1`) into `index.ts` + `types.ts` with no import beyond the platform: `createClient({ baseUrl, headers })`, one method per `operationId`, a non-2xx as `ProblemError`, and `refusalOf(error, 'publishPost')` narrowing to the codes that operation declares under `errors:`. The calling direction is `x client vendor <name>` — `outbound()` and `t` schemas from a third party's document. One compiler for both, never a second way: [CLI reference](CLI-Reference#x-client). `As of 2026-11`.

**A bulk endpoint is one action.** `hive({ member, split, onMemberError })` (`@ultimat3/ai`) runs `member` once per item under its own policy and answers per-item outcomes — `{ index, status: 'ok' | 'failed', … }` — so a bulk operation is in OpenAPI, the typed client, the customer client and MCP by construction, with no batch route to hand-write.

Plus cache invalidation: `cache.invalidates` fans out to request memo, in-process LRU (all instances, over NATS), Redis, ISR pages, and the CDN purge webhook in one hop ([Caching and invalidation](Caching-And-Invalidation)).

There is **one execution path**. HTTP, MCP, jobs, and direct server calls differ only in the surface they declare, which selects how a denial is rendered — never whether authz runs and never how input is validated.

## The API as a whole — `defineApi({ http, openapi })`

`As of 22.6.0`. Declared once, beside the primitives, and read by the boot and `x manifest`:

| Key | Effect |
|---|---|
| `http.pathStyle` | `'resource'` (default — every existing URL stays) or `'readable'`: `signIn` → `/api/sign-in`, `health` → `/api/health`. A browser states nothing: the server stamps a non-default style into every document (`<meta name="ultimate-path-style">`) and `rpc({ baseUrl: '' })`, `useMutation` and the outbox replay derive under it. A caller with no document — a script, another service — passes `rpc({ baseUrl, pathStyle: 'readable' })`; the wrong one is answered 404 `X_CONTRACT_DRIFT` naming the style served and the action's real path, never a bare `X_ROUTE_NOT_FOUND`. The module scan evaluates `apps/web/api/index.ts` first, so a module-level `derivePath(name)` anywhere else sees the declared style; one evaluated earlier (inside the index's own imports) is refused at the declaration, `X_ACTION_PATH_DERIVED_EARLY` — derive inside the function that uses it |
| `http.mounts[]` | `{ prefix: '/v1', scopes, resolveToken, rateLimit?, openapi? }` — a second door onto a cut of the same routes. Only `Authorization: Bearer` authenticates there (a session cookie reaches nothing, so no CSRF proof is needed); a primitive outside the token's scopes answers **404** like MCP's unknown tool; no/invalid token **401** with `WWW-Authenticate: Bearer`; a per-token `rateLimit` answers `RateLimit-*` and **429** + `Retry-After`, and it **replaces** the `default` bucket on the mount's routes (no `rateLimit`, `default` stands; a route's own bucket and the tenant allowance still apply). A `Link: rel="successor-version"` names the mounted path, and is dropped when the successor is outside this token's cut. `scopes` is the map `defineAppMcp` takes; `resolveToken` the same resolver. `/api/create-case` → `/v1/create-case`, `/_x/query/case-list` → `GET /v1/case-list` |
| `http.mounts[].openapi` | a file (`'openapi.v1.json'`) `x manifest` writes with only the cut, bearer-secured; `x verify` refuses it stale or missing. Each operation's `security` is `[{ bearer: ['<its scope>'] }]` — the one scope of `scopes` that names it (also `x-ultimate.scope`) — and `components.securitySchemes.bearer` lists every scope with the operations it unlocks, in its `description` and as `x-ultimate.scopes` (`{ scope: [names] }`). `As of 22.12`; before, every operation said `bearer: []` |
| `openapi` | `{ title, version, description, servers, sessionCookie }` — any key makes `openapi.json` complete: `info`, `servers`, `securitySchemes` (`cookie`, plus `bearer` with a mount), `401` + `429` (with `Retry-After`) on every operation its route authenticates, `RateLimit-*` on rate-limited ones. Absent, the bytes are unchanged |

## One authz system

`policy` is evaluated for the HTTP call, the typed client call, the job execution, the MCP tool call, and the live-query subscription — the same function, the same actor resolution, the same denial error.

> **Two authz systems is how every Meteor-like framework died.** Meteor had `allow`/`deny` rules for the client sync path and plain method bodies for the server path; the two drifted, and the drift *was* the security model. Anything that lets an agent expose data through a second door — a "public" MCP tool, an "internal" RPC, a sync rule table — is a rejected design, not a config option.

Rejected by that rule: an MCP-specific permission table, a "trusted tool" mode, a broad-rights service account for agents, and an internal RPC surface that skips `policy`. Details in [Policies and authz](Policies-And-Authz).

## `action` must never

- read the request object, headers, or cookies directly — actor and tenant come from `ctx`.
  One exception is a caller whose credential is a **signature over the raw body** — a signed
  upload. `useRequestBodyBytes()` from `@ultimat3/http` returns the exact bytes the body was
  parsed from (the same size-capped, cached read). Off HTTP (a job, MCP) it is `X_NO_REQUEST`.
  A vendor's **webhook** never comes through an action: the input schema answers 400/422 before
  the signature is checked, and `application/xml`, `application/octet-stream` or no content type
  is `X_BODY_INVALID` with the handler never reached. The one door is `webhookReceiver()`
  ([Jobs and workflows](Jobs-And-Workflows#inbound-webhooks))
- render, redirect, or return HTML
- perform its own authorization inside `handle` — that belongs in `policy`
- do slow work inline — enqueue a `job`
- share a file with another primitive — one per file, in the feature's `actions/`

Logic lives in `service.ts`; `actions/` holds declarations. An action whose `handle` is more than a few lines of orchestration is a service waiting to be extracted.

## `mutator` — action + optimistic twin

Same declaration surface as `action`, plus a local half that runs client-side against the local store while the server call is in flight.

```ts
export const likePost = mutator({
  // REQUIRED (`X_MUTATOR_NOT_IDEMPOTENT`): a replay under the same Idempotency-Key answers the
  // first result instead of running `server` again.
  idempotent: true,
  // Convergent, not incremental: `local` replays on every rebase, so applying it N times has to
  // equal applying it once — `likedByMe` is what makes the second application a no-op.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Aspect | Rule |
|---|---|
| Projects to | everything `action` does, plus a local-store transaction and a rebase entry |
| Owns | conflict strategy: `'server-wins'`, `'last-write-wins'`, or `custom(merge)` |
| Authz | the `server` half carries the policy; the `local` half is presentation only and never a security boundary |
| Idempotency | `idempotent: true` is required — a compile error, and `X_MUTATOR_NOT_IDEMPOTENT` at declaration. The client replays a mutator's write under one `Idempotency-Key` (a retry, the offline queue draining), and the replay answers the first result instead of running `server` again |
| Never | let `local` do I/O, randomness, or `Date.now()` |

**Replayability rule:** `local` is re-executed on every rebase — after each server confirmation, on reconnect, and when a conflicting remote write arrives. It must be a pure function of `(tx, input)`. I/O, `Math.random()`, `crypto.randomUUID()`, or a wall-clock read makes the local timeline diverge from the server's, and the divergence surfaces as flicker, then as wrong data. Ids and timestamps come from the input, generated once at call time. Tier 3 local-first (`persist: true`) has **not shipped**, `As of 2026-08`; mutators work today at realtime tiers 1–2 ([Realtime](Realtime)).

## Errors

| Code | When | Fix |
|---|---|---|
| `X_ACTION_POLICY_MISSING` | an action registered without `policy` | add `policy: can('<name>')` to the declaration |
| `X_ACTION_DUPLICATE` | two actions share an export name | rename one — names are globally unique |
| `X_INPUT_INVALID` | body fails the `input` schema — including a string (or a `t.record` key) carrying U+0000, which every string-backed `t` refuses because Postgres `text`/`jsonb` cannot store it. Tabs, newlines and the other C0 controls are accepted. `As of 2026-09-29` | `x actions show <name> --json` prints the expected schema |
| `X_FORBIDDEN` | the policy said no — one code for the direct call, the HTTP 403 and the MCP tool error | grant the capability, or call as an actor who has it |
| `X_UNAUTHENTICATED` | no session; anonymous actor hit a policy needing one (401) | sign in, or send a valid token |
| `X_IDEMPOTENCY_CONFLICT` | key reused with a different payload, or still in flight | send a fresh `Idempotency-Key`, or retry after the first settles |
| `X_IDEMPOTENT_REPLAY_REDACTED` | a replay of an answer whose secret-named field (`isRedactedKey`, or a `Secret`) was stored as `[redacted]` — the first call ran, its answer is not kept in plaintext (409) | read the effect with a query; a new `Idempotency-Key` runs the call again |
| `X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE` | a keyed handler's answer holds a value JSON has no form for (a `bigint`), so no retry could replay it. The handler ran, and a retry replays this refusal | return JSON from `handle`: `String(id)` for a `bigint`, then send a fresh `Idempotency-Key` |
| `X_IDEMPOTENCY_RESERVATION_LOST` | an idempotent action inside a transaction outlived the request deadline and a retry took its key; its transaction rolls back (409) | resend with the same `Idempotency-Key` |
| `X_ACTION_ERRORS_INVALID` | an `errors:` entry is not `X_SCREAMING_SNAKE`, has no registered 4xx status, or repeats | `defineError({ code, status })` first and import it, then list it once |
| `X_ERROR_UNDECLARED` | a test or dev run threw a 4xx code outside `errors:`, or `.contract()`'s scan found one | add `'<CODE>'` to `errors:`, or stop throwing it there |
| `X_MUTATOR_NOT_IDEMPOTENT` | a `mutator` declared without `idempotent: true` | add `idempotent: true` to the definition |
| `X_CONTRACT_DRIFT` | client build id ≠ server build id, or a breaking published-contract change | reload the client / bump the action version |
| `X_TENANCY_UNSCOPED` | a query inside `handle` had no tenant predicate | scope it through the repo, never raw SQL |
| `X_BOUNDARY_VIOLATION` | action declared outside `api/` or `<feature>/actions/` | move the file, or `x fix boundary <file>` |
| `X_LAYOUT_SIBLING_MODULE` | a module `actions.ts` beside the directory `actions/` | move each declaration to `actions/<name>.ts`, then delete the file |

```
X_ACTION_POLICY_MISSING: action registered without a policy
  cause: action "publishPost" was registered without a policy
  fix:   add `policy: can('publishPost')` to the action definition in the file that exports it
```

Every code carries the same `{ code, cause, fix, docs }` in the terminal, the dev overlay, the HTTP body, `--json`, and the MCP tool error. Full list: [Error codes](Error-Codes).

A handler's OWN refusals are app codes, each declared once with `defineError` from
`@ultimat3/core/page` (the barrel carries the framework's titles into every island that throws one)
— the title, the status the HTTP projection answers and the class `handle` throws:

```ts
import { defineError } from '@ultimat3/core/page';

export const PostNotFound = defineError<string>({
  code: 'X_POST_NOT_FOUND',
  title: "no such post in the actor's organisation",
  status: 404,
  cause: (ref) => `no post ${ref} in the actor's organisation`,
  fix: 'x queries list --json, then pass an id the post read returns',
});

// in handle: throw new PostNotFound(input.postId);
```

A code with no status answers 500 and hides its cause from the caller; `offSocket: true` declares a
code no response carries. `guards/error-declared.ts` refuses a handwritten `UltimateError` subclass.

### Declared refusals (`errors:`)

`errors: [PostNotFound.code, 'X_FORBIDDEN']` names the 4xx codes a caller may branch on. Import
the class and list its `.code`: the import is what registers the status before the list is
checked. Judged at the one place a handler runs: a throw out of `handle` or `row` only — the
policy, the parse, the rate limit and idempotency sit outside, so `X_FORBIDDEN` from the policy or
`X_INPUT_INVALID` is never judged.

| Thrown out of `handle`/`row` | Test, development | Production (or no environment named) |
|---|---|---|
| a listed code | itself | itself |
| a 4xx code not listed | `X_ERROR_UNDECLARED`, the original as `sourceError`, the fix naming the code to add | itself, `logger.warn` + `undeclared_errors_total{primitive,name,code}` |
| a 5xx, a statusless code, `X_ABORTED`, `X_DRAINING`, a non-coded throw | itself | itself |

- **OpenAPI**: each code joins `responses[status]`. A status only the list answers narrows
  `Problem.type` to an enum of `urn:ultimate:error:<CODE>`; a status the framework already answers
  (`400`, `403`, `409`) keeps its open `Problem` and names the code in its description. Both carry
  `x-ultimate-errors: [<codes>]`. Undeclared, the document's bytes are unchanged.
- **`.contract()`** gains one assertion: a code literal or a `defineError` class in `handle`'s or
  `row`'s own source, 4xx and outside the list, fails it. First hop only — a code thrown behind a
  helper is judged when a test reaches it (the generated exercise runs included). A path nothing
  reaches stays unjudged; a class imported under another name is missed by the scan.
- **MCP and the in-app agent's tool**: the description ends `Declared refusals: <codes>.`
- **Nested `invoke`**: an inner action's declared refusal is the outer's to declare too — the
  outer's caller receives it.
- **`x.manifest.json`**: `errors` on the action's fact; removing a code is breaking, adding one additive.


## Introspection

```
$ x actions list --json
{"ok":true,"command":"actions","summary":"1 action","findings":[],
 "data":[{"kind":"action","mutator":false,"name":"publishPost","verb":"publish",
   "resource":"posts","method":"POST","path":"/api/posts/publish",
   "capability":"post:publish", …}]}
```

Both subcommands emit the same `describe()` row — `list` one per action, `show` the named one. It is exactly what `publishPost.describe()` returns in process, so the CLI has no private view of a primitive:

```
$ x actions show publishPost --json
{"ok":true,"command":"actions","summary":"action publishPost","findings":[],
 "data":{"kind":"action","mutator":false,"name":"publishPost","verb":"publish",
  "resource":"posts","method":"POST","path":"/api/posts/publish",
  "capability":"post:publish",
  "input":{"type":"object","required":["postId"],
    "properties":{"postId":{"type":"string","format":"uuid"},
                  "notify":{"type":"boolean","default":true}}},
  "output":{"$ref":"#/components/schemas/PostView"},
  "invalidates":["feed","post"],"idempotent":false,
  "mcp":{"expose":true,"tool":"publishPost","description":"Publish a draft post"},
  "rateLimit":null}}
```

`invalidates` is sorted and de-duplicated, so descriptor output never depends on declaration order — a diffable contract. `mutator` is `true` only for a `mutator()` declaration; `kind` stays `"action"` for both, which is why the flag is a field of its own and not a second `kind`. The same data is the MCP `actions.describe` tool (actions and queries in one call) and the `/_x` **Routes** panel.

## Generated contract test

Emitted with the action, and green on the first run: it pins the invariant the action owns — a non-owner is denied — rather than a `TODO` someone has to notice.

```ts
// contract test — generated with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_FORBIDDEN');
});
```

Runs against a cloned Postgres (`CREATE DATABASE … TEMPLATE`), never a mock. `x test contract` asserts the input/output schema round-trip, one denial per policy branch, and that the emitted OpenAPI operation plus MCP tool shape still match the declaration. See [Testing](Testing).
