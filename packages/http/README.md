# @ultimat3/http 🌐

A thin, **owned** layer over `Bun.serve`. Not a framework-agnostic HTTP kit — the
lifecycle belongs to us so ALS context, tracing, locale/tz and authz are impossible
to skip.

## What it owns

| Concern | Module |
|---|---|
| server lifecycle, drain, `/healthz` + `/readyz` | `server.ts` |
| route table, matcher, `describeRoutes()` | `router.ts` |
| the ordered request lifecycle | `pipeline.ts` |
| typed request (params, query, body) | `request.ts` |
| response constructors + `problem()` | `response.ts` |
| code → status, closed table | `error-map.ts` |
| `factsOf()`, the problem document, the terminal lines | `error-facts.ts` |
| token-bucket limiting, `toBucket` | `rate-limit.ts` |
| the app's own HTTP declaration, and the boot's facts over it | `app-config.ts` |
| CORS, CSP/HSTS | `cors.ts`, `security-headers.ts` |
| CSRF (origin proof for a credentialed write) | `csrf.ts` |
| the request deadline and `ctx.signal` | `deadline.ts` |
| the caller's real address behind a proxy | `forwarded.ts` |
| the inbound request id and trace, read before the span | `correlation.ts` |
| dev error overlay | `overlay.ts` |

## What an app declares: `configureHttp()`

```ts
// apps/web/app/http.ts — module scope, imported by the app like any other module
import { configureHttp } from '@ultimat3/http';

configureHttp({
  cors: { origins: ['https://app.example.com'], credentials: true },
  bodyLimitBytes: 8 * 1024 * 1024,   // this API takes a 4 MB CSV
  requestTimeoutMs: 300_000,          // and an export that really does take five minutes
  rateLimit: {
    tenantBucket: 'tenant',
    buckets: { tenant: { capacity: 5_000, refillPerSecond: 100 } },
  },
});
```

One registration, read once by whatever process starts the web role — the same seam
`configureAuthenticator()` is. **Breaking, `As of 2026-08-24`**: before it, the only `HttpConfig`
any shipped process built was a fixed literal inside `@ultimat3/cli`, so none of the four values
above could be set from an app at all — `cors.origins` was `[]` in every deployment, which refuses
every cross-origin browser call, permanently. `AppConfig` has never carried an `http` key and does
not gain one: `@ultimat3/core` is tier 0 and cannot hold this package's types.

`AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>` — `port`, `hostname`, `dev`,
`buildId`, `signInPath`, `trustProxy`, `trustedProxyHops` and `rateLimit.scope` are the boot's, and
writing one here is a **type error** rather than a value silently overwritten at the next boot.
`mergeHttpConfig(configuredHttp(), boot)` is the layering, and it merges `security.csp.extend` per
directive: the app's CDN source and the boot's inline-script hash are each the whole answer for
something.

## The pipeline is the guarantee

```
request-id → admit → trace → context → locale → auth → rate-limit → csrf → body → authz
           → handler → cache-headers → (error-map) → response
```

Exported as `PIPELINE_STAGES`, each entry carrying a `why`. `pipeline.test.ts`
asserts the order; `/_x` renders it. Ordering rules worth restating:

| Rule | Reason |
|---|---|
| admit second | a draining or saturated process refuses before any work — no route match, no auth, no body |
| auth before rate-limit | limiter keys per actor/tenant, not per NAT address |
| csrf after auth | only a caller holding an AMBIENT credential can be forged into; bearer and anonymous are exempt |
| csrf before body | a forged write never makes the server allocate its payload |
| rate-limit before body | a limited request never allocates its payload |
| body before authz | policies take parsed input as their subject |
| cache-headers before response | a directive can never drop a security header |

What the lifecycle refuses on the caller's behalf, `As of 2026-08`:

| Guard | Answer |
|---|---|
| a body past `bodyLimitBytes` | read through the stream and abandoned the instant the running total crosses the limit — `content-length` or not, multipart included — as `X_BODY_INVALID` |
| a request carrying an identity on an `auth: 'public'` route | `cache-control: private`, never `s-maxage`; an anonymous one is shared-cacheable and keyed `vary: accept-language, cookie, x-timezone`. **Whatever the handler wrote**, `As of 2026-08-23`: the `cache-headers` stage REVIEWS a declared `cache-control` instead of standing down, because `@ultimat3/render`'s `ssrHeaders` offers every page without a `policy` to a CDN for 30s. An `immutable` answer is left alone — a content-addressed body is a function of its URL |
| a 5xx nobody declared a status for | the code, the request id and a `fix:`; never the exception's own text. `error-page.ts` locked the browser out of it, and the problem document handed the same string to an agent — a driver's DSN, the row Postgres rejected. The real text goes to the log and the error report. `dev: true` renders it in full |
| a `security.csp.extend` key that is not a CSP token, or a source carrying `;`, `,` or a space | `X_CSP_DIRECTIVE_INVALID` at `defineHttpConfig` — `{ 'x; script-src *': [] }` is a second directive nobody declared |
| a repeated form field | a LIST, exactly as a repeated query parameter is. One collector for query, urlencoded and multipart; `Object.fromEntries` kept the last value, so a checkbox group reached the schema as one string |
| a cross-origin request from an origin the allow-list refuses | no `access-control-allow-origin`, but always `vary: origin`, so a shared cache never answers an allowed origin out of the refusal's slot |
| `cors.origins: ['*']` with `credentials: true` | `X_CORS_CONFIG_INVALID` at `defineHttpConfig`, because a browser accepts that pair from nobody |
| `?next=` carrying anything but a same-origin path | the fallback — including a value whose TAB/CR/LF a browser strips back into `//evil.test` |
| HSTS | emitted only when the connection is affirmatively https (`ctx.https`); never by the zero-argument default |
| `rateLimit.scope: 'shared'` on a per-process store | `X_RATE_LIMIT_NOT_SHARED` at `createServer`, because N replicas each holding their own counters enforce N × every configured number |
| a route's own bucket and a configured bucket of that name disagreeing | `X_RATE_LIMIT_BUCKET_CONFLICT` at `createServer`, because the loser would be a number someone read and nothing applied |
| a `rateLimit.tenantBucket` naming a bucket nothing declares | `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN` at `defineHttpConfig`, because the name would fall through to `default` and a whole tenant's cap would silently be the 120-burst read bucket |
| an injected limiter that does not hold a bucket a route declares | `X_RATE_LIMIT_BUCKET_UNBOUND` at `createPipeline`, because the name would fall through to `default` — measured at 120 burst for a route declaring 5 |
| a config that never declared `rateLimit.scope` | `X_RATE_LIMIT_SCOPE_UNSET` at `defineHttpConfig`. **Breaking, `As of 2026-08`**: `'process'` used to be the default, so "nobody asked" and "the app said one replica" were the same value while the chart runs three |
| `trustProxy: true` with no `trustedProxyHops` | `X_TRUST_PROXY_UNSET` at `defineHttpConfig`. **Breaking, `As of 2026-08`**: `trustProxy` now defaults to `false`, and `x-forwarded-for` is read at `entries.length - hops` — never at `[0]`, which is whatever the client typed |
| a credentialed unsafe method that cannot be shown to be same-origin | `X_CSRF_BLOCKED` (403). `sec-fetch-site: same-origin`, `Origin` equal to this app, or an `Origin` in `cors.origins` — anything else is refused before the body is read |
| a request past `requestTimeoutMs` (30s) | `ctx.signal` aborts and the socket is answered `X_TIMEOUT` (504); a caller may shorten the deadline with `x-request-timeout-ms`, never lengthen it |
| the caller going away mid-request | `ctx.signal` aborts on the inbound `Request.signal` too, so a closed tab unwinds cooperative work instead of holding its pool slot for the rest of the budget. Both halves are one signal (`AbortSignal.any`), and `requestTimeoutMs: 0` still delivers the caller's |
| a request while the process is draining | `X_DRAINING` (503) + `retry-after`, which is what `isDraining()` was always documented to do here and had no reader for |
| a request past `maxInflight` (1000) | `X_OVERLOADED` (503) + `retry-after`, shed in the `admit` stage before any work |

`handle()` resolves to a Response, always — a stage that throws after the handler, or while
rendering another stage's throw, degrades to `X_PIPELINE_FINALIZE_FAILED` (500, the stage named in
`cause`) and the chain finishes that document instead. `finalize.ts` owns that promise.

## Rate limiting holds where the app says it holds

The counters live in a `RateLimitStore`. `memoryRateLimitStore()` is the default and is **one
process' worth of state**, so a deployment at `replicas: 3` enforces every bucket three times over.
The app declares which it needs and passes the store that provides it — the store is the only
thing that knows where its counters live, and a framework that inferred the answer from the
environment would get it wrong on the first deployment that scaled differently.

```ts
import {
  createServer,
  defineHttpConfig,
  type RateLimitStore,
  type Route,
} from '@ultimat3/http';

declare const routes: readonly Route[];
declare const myStore: RateLimitStore;   // postgresRateLimitStore({ executor }), say

createServer({
  routes,
  config: defineHttpConfig({ rateLimit: { scope: 'shared' } }), // this limit is the fleet's
  rateLimitStore: myStore,                                      // whose own scope is 'shared'
});
```

| Declared | Store | Result |
|---|---|---|
| nothing | any | `X_RATE_LIMIT_SCOPE_UNSET` at `defineHttpConfig` — **breaking, `As of 2026-08`** |
| `'process'` | any | boots; the limit is per replica, which is what was asked for |
| `'shared'` | `scope: 'shared'` | boots; one bucket for the fleet |
| `'shared'` | `scope: 'process'`, or `enabled: false` | `X_RATE_LIMIT_NOT_SHARED` at boot |

There is no default. `'process'` used to be one, which made "the app never said" and "the app
said one replica" the same value while `docker/helm/values.yaml` runs three — and
`X_RATE_LIMIT_NOT_SHARED` only fires on a `'shared'` declaration, so the silent case was exactly
the one nobody declared. A limiter with `enabled: false` owes no declaration: nothing is enforced,
so nothing can be wrong.

`rateLimitStore` feeds the `PipelineDeps.limiter` seam rather than sitting beside it: the bucket
maths stays in `createRateLimiter`, so every driver agrees on the numbers.

**One request spends a LIST of keys, `As of 2026-08-24`** — the caller's (`actor`, else `org`,
else `ip`) and, when the app declared `rateLimit.tenantBucket`, that caller's tenant. The key
builder used to pick exactly ONE subject and consult `orgId` only when there was no actor id,
which no authenticated request ever satisfies: a tenant with 8,000 seats took 8,000 × the
per-actor burst against one shared pool, every bucket inside its own limit, and no number an
operator could set would have refused it. The tenant key is `tenant|org:<id>` and is deliberately
NOT scoped to the route — a per-route tenant bucket is the same allowance once per route. The
spend stops at the first refusal, so a caller its own bucket refused costs its tenant nothing, and
the `ratelimit-*` headers report the bucket closest to refusing. `tenantBucket` defaults to `null`:
one tenant is a person and the next is five thousand seats, so there is no allowance a framework
can pick for you.

**A shared store ships, `As of 2026-08`** — `postgresRateLimitStore({ executor })`, one table
and one `insert … on conflict` per take, so N replicas count against one bucket. Until it landed,
`scope: 'shared'` was a declaration nothing in the framework could satisfy while `x new` scaffolded
`replicas: 2`. `executor` is a `PgExecutor` — anything speaking `query(text, values)`, which is one
line over the client the boot already opened; **never `Bun.sql`**, whose `.query` is `undefined`.

```ts
import { db, type SqlFragment } from '@ultimat3/db';
import {
  createServer,
  defineHttpConfig,
  type PgExecutor,
  postgresRateLimitStore,
  type Route,
} from '@ultimat3/http';

declare const routes: readonly Route[];

// The client this process already opened, wrapped in one line. `@ultimat3/cli`'s `pgExecutorFor`
// is this exact function, and it is what the boot passes when it installs the store for you.
const client = db();
const executor: PgExecutor = {
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values } satisfies SqlFragment),
};

createServer({
  routes,
  config: defineHttpConfig({ rateLimit: { scope: 'shared' } }),
  rateLimitStore: postgresRateLimitStore({ executor }),
});
```

The table bounds itself only when something asks it to: `store.purgeExpired(ctx.now().getTime())`
from a `task` drops every bucket that has refilled to capacity, which is the memory store's forget
rule. `nowMs` is required and must come from the same clock the takes use — measured against the
server's clock instead, the offset between the two reads as refill and deletes buckets a throttled
caller is still sitting in.

The maths reads an injected `Clock`, defaulting to `systemClock`: `createRateLimiter({ config,
clock })`. **Breaking, `As of 2026-08-19`** — it took `now?: () => number` before and read
`Date.now()` when nothing passed one, which both production call sites did, so the limiter that
actually throttles a request could not be frozen. Replace `now: () => t` with
`clock: frozenClock(t)`; a limiter you build yourself still reaches the pipeline through
`PipelineDeps.limiter`, which stays the only seam for one.

### A route may bring its own bucket

`meta.rateLimit` names a bucket; `meta.rateLimitBucket` is the numbers that bucket must hold.
`withRouteBuckets` registers them at construction — `createServer` and `createPipeline` both apply
it, idempotently — because `defineHttpConfig` runs before any route exists and cannot have them.
Without that half, a name nothing defined fell through `bucketFor` to `default`: an action
declaring `limit: 5` ran on 120 burst, and the number reached the OpenAPI document all the same.

| Declared | Configured under the same name | Result |
|---|---|---|
| nothing | — | `default`, unchanged — most routes |
| numbers | nothing | the route's numbers, registered |
| numbers | the same numbers | boots; a restatement is not a disagreement |
| numbers | different numbers | `X_RATE_LIMIT_BUCKET_CONFLICT` at boot |

Neither source wins a disagreement, because whichever lost would stay a number an author read and
nothing enforced. `toBucket` — in **this** package, beside `Bucket` and the maths it validates, because `action` and
`query` are the same tier and can never import each other — is the one conversion from a
declaration's
`{ limit, windowMs }` to a bucket's `{ capacity, refillPerSecond }`, and it refuses a pair the
limiter could not run on — including one whose two halves look fine and whose **division** does
not, like `{ limit: Number.MAX_VALUE, windowMs: 1 }` computing to an infinite refill.

Registering into the config is only half of it, because the limiter resolves names against the
table **it** closed over. `RateLimiter.buckets` publishes that table — declared, never inferred,
the same rule as `RateLimitStore.scope` — and `assertRouteBuckets` compares it against the routes
at construction. A limiter passed to `PipelineDeps.limiter` that cannot enforce a declared bucket
is refused rather than rebound: a `RateLimiter` is opaque, so rebinding would mean discarding the
store it carries, and a caller who built their own limiter may have meant their own numbers. Pass
the **store** — `createServer({ routes, rateLimitStore })` — and the pipeline builds the limiter
from the merged table for you.

## Routing

Precedence is structural, not declaration-ordered: **static > param > wildcard**,
depth-first with backtracking. A tie is `X_ROUTE_CONFLICT` at startup, never a coin
flip. `HEAD` falls back to the `GET` route. `meta.auth` is **required** — a route
cannot forget to declare its auth posture.

```ts
import { createServer, defineHttpConfig, json } from '@ultimat3/http';

const handle = createServer({
  routes: [{ method: 'GET', path: '/posts/:id', meta: { name: 'posts.show', auth: 'public' },
             handler: (req) => json({ id: req.param('id') }) }],
  config: defineHttpConfig({ port: 3000 }),
  role: 'web',
}).start();
```

Static paths are registered in Bun's native `routes` table; param/wildcard paths fall
through to `fetch`. Method resolution stays ours so a 405 still carries problem+json.

### No WebSocket upgrade on the `web` role, and no hand-written `api/` route

`As of 2026-09-05`, and stated because an app went looking for both. The `web` role's
`Bun.serve` is built with no `websocket` handler (`server.ts`: "the `web` role does not use one"),
so nothing under `/api` can `server.upgrade()` a request; and `/api/*` is a **projection** —
`apiRoutes()` in `@ultimat3/cli` mounts every `action` and `query` the registries hold, and
`x g route --surface api` does not exist (`readSurface` refuses `api` by name). A raw socket is
not an action, so it has no home on this role.

The framework's one WebSocket is the `sync` role's (`@ultimat3/realtime/server`, `PORT + 1`),
authenticated by `SyncAuthenticator` and reached from the browser through `LiveClient`. A
bidirectional stream — a PTY, a log tail — is written as **two halves that already exist**:

| Direction | Primitive | Why |
|---|---|---|
| server → browser | a `channel` topic on the sync socket (`ChannelHub`, `topic(...)`, `client.subscribe(topic, …)`) | ordered frames, reconnect and backpressure are the sync node's, not a second socket's |
| browser → server | an `action` — one call per keystroke batch | it gets a policy, a schema, rate limiting, audit and the typed client for free; a socket message gets none |

A `web`-role upgrade hook was refused rather than half-built: the pipeline returns a `Response` at
every stage (middleware, finalize, security headers), and an upgraded request must return
`undefined` from `fetch` — a second exit from the pipeline with none of its guarantees. If the two
halves above cannot carry a case, the fallback is a long-poll `action` (`GET`-shaped, returning
`{ frames, cursor }` and re-called on return), which is what the app that asked shipped.

## Inbound webhooks

`verifyWebhookSignature(request, { secret })` is the receiving half of the framework's webhook
mechanism. It is a plain function and not a pipeline stage, because the secret is **per sender**
and only the route knows which one applies.

```ts
// apps/web/api/webhooks/partner/route.ts
import { verifyWebhookSignature } from '@ultimat3/http';

declare const env: { readonly PARTNER_WEBHOOK_SECRET: string };   // the app's defineEnv() result
// The seen-set and the dispatch are the app's — this package has nowhere to keep either.
declare function alreadyHandled(eventId: string): Promise<boolean>;
declare function handle(topic: string, payload: unknown, eventId: string): Promise<void>;

export async function POST(request: Request): Promise<Response> {
  const { eventId, topic, body } = await verifyWebhookSignature(request, {
    secret: env.PARTNER_WEBHOOK_SECRET,
  });
  // Parse the bytes that were SIGNED. Never `request.json()` — the stream is spent, and a
  // re-serialisation would not be the bytes the mac covers.
  const payload: unknown = JSON.parse(body);
  if (await alreadyHandled(eventId)) return new Response(null, { status: 200 });
  await handle(topic, payload, eventId);
  return new Response(null, { status: 202 });
}
```

| Property | How |
|---|---|
| constant time | the mac is compared with `@ultimat3/core`'s `timingSafeEqual`, never `===` — where two macs first differ is exactly what a timing oracle forges one byte at a time |
| a replay expires | the signature's timestamp is checked against `toleranceMs` (5 minutes by default), **both** directions — a sender whose clock runs ahead is the same window pointed the other way |
| a replay is detectable | `eventId` is signed and returned, so it cannot be moved in transit; the seen-set is your table, because the framework has nowhere to keep one |
| moving the timestamp breaks it | the timestamp is inside the canonical string, so editing `t=` on a captured request invalidates the mac |
| the raw bytes are what is verified | the body is read through core's counting reader — the same one `UltimateRequest` uses — so a sender that declares no length cannot make this handler hold an unbounded payload |
| the mac is checked BEFORE the window | `X_WEBHOOK_SIGNATURE_STALE` means *authentic and old*, never *unreadable and old*, so an operator reading it goes to a clock or a replay |

`X_WEBHOOK_SIGNATURE_INVALID` and `X_WEBHOOK_SIGNATURE_STALE` are both **401**: the request is
well formed and carried a credential, and the credential is what failed. Neither triggers the
sign-in redirect, which keys on `X_UNAUTHENTICATED` alone.

The sending half is `webhook()` in `@ultimat3/jobs`. Neither package may import the other, so the
canonical string is stated in both and pinned by one literal vector asserted in both test files.

## Errors

`X_ROUTE_NOT_FOUND` · `X_METHOD_NOT_ALLOWED` · `X_BODY_INVALID` · `X_UNAUTHENTICATED`
· `X_FORBIDDEN` · `X_RATE_LIMITED` · `X_BUILD_SKEW` · `X_ROUTE_CONFLICT`
· `X_CORS_CONFIG_INVALID` · `X_RATE_LIMIT_NOT_SHARED` · `X_WEBHOOK_SIGNATURE_INVALID`
· `X_WEBHOOK_SIGNATURE_STALE`

One `factsOf()` feeds three renderings — terminal, `application/problem+json`, dev
overlay — so the `code`/`cause`/`fix` strings can never diverge.

A problem document's `type` and `docs` answer different questions and are two different
values. `type` is `problemTypeFor(code)` — `urn:ultimate:error:X_BODY_INVALID`, the RFC-9457
identifier a client switches on, per code, with no host to resolve or rot. `docs` is
`@ultimat3/core`'s `ERROR_DOCS_URL`, one wiki page for every code, because a code lives there
in a table row and a table row has no anchor. Assert against `problemTypeFor` and
`ERROR_DOCS_URL`, never against a copy of either string.

## Boundaries

Tier 2. Imports `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/i18n` and `@ultimat3/time` —
tiers 0 and 1, which is the whole rule. Authentication and policy evaluation arrive through
`ServerHooks`, declared structurally, because `@ultimat3/policy` is a sibling tier. There is no
plugin API: `Middleware` wraps a handler, the pipeline is everything else.
