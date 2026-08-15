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
| code → status, `factsOf()` | `error-map.ts` |
| token-bucket limiting | `rate-limit.ts` |
| CORS, CSP/HSTS | `cors.ts`, `security-headers.ts` |
| dev error overlay | `overlay.ts` |

## The pipeline is the guarantee

```
request-id → trace → context → locale → auth → rate-limit → body → authz
           → handler → cache-headers → (error-map) → response
```

Exported as `PIPELINE_STAGES`, each entry carrying a `why`. `pipeline.test.ts`
asserts the order; `/_x` renders it. Ordering rules worth restating:

| Rule | Reason |
|---|---|
| auth before rate-limit | limiter keys per actor/tenant, not per NAT address |
| rate-limit before body | a limited request never allocates its payload |
| body before authz | policies take parsed input as their subject |
| cache-headers before response | a directive can never drop a security header |

What the lifecycle refuses on the caller's behalf, `As of 2026-08`:

| Guard | Answer |
|---|---|
| a body past `bodyLimitBytes` | read through the stream and abandoned the instant the running total crosses the limit — `content-length` or not, multipart included — as `X_BODY_INVALID` |
| a request carrying an identity on an `auth: 'public'` route | `cache-control: private`, never `s-maxage`; an anonymous one is shared-cacheable and keyed `vary: accept-language, cookie` |
| a cross-origin request from an origin the allow-list refuses | no `access-control-allow-origin`, but always `vary: origin`, so a shared cache never answers an allowed origin out of the refusal's slot |
| `cors.origins: ['*']` with `credentials: true` | `X_CORS_CONFIG_INVALID` at `defineHttpConfig`, because a browser accepts that pair from nobody |
| `?next=` carrying anything but a same-origin path | the fallback — including a value whose TAB/CR/LF a browser strips back into `//evil.test` |
| HSTS | emitted only when the connection is affirmatively https (`ctx.https`); never by the zero-argument default |
| `rateLimit.scope: 'shared'` on a per-process store | `X_RATE_LIMIT_NOT_SHARED` at `createServer`, because N replicas each holding their own counters enforce N × every configured number |
| a route's own bucket and a configured bucket of that name disagreeing | `X_RATE_LIMIT_BUCKET_CONFLICT` at `createServer`, because the loser would be a number someone read and nothing applied |
| an injected limiter that does not hold a bucket a route declares | `X_RATE_LIMIT_BUCKET_UNBOUND` at `createPipeline`, because the name would fall through to `default` — measured at 120 burst for a route declaring 5 |

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
createServer({
  routes,
  config: defineHttpConfig({ rateLimit: { scope: 'shared' } }), // this limit is the fleet's
  rateLimitStore: myStore,                                      // whose own scope is 'shared'
});
```

| Declared | Store | Result |
|---|---|---|
| `'process'` (default) | any | boots; the limit is per replica, which is what was asked for |
| `'shared'` | `scope: 'shared'` | boots; one bucket for the fleet |
| `'shared'` | `scope: 'process'`, or `enabled: false` | `X_RATE_LIMIT_NOT_SHARED` at boot |

`rateLimitStore` feeds the `PipelineDeps.limiter` seam rather than sitting beside it: the bucket
maths stays in `createRateLimiter`, so every driver agrees on the numbers. **No shared store ships
yet, `As of 2026-08`** — `memoryRateLimitStore()` is the only implementation in the framework.

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
nothing enforced. `@ultimat3/action`'s `toBucket` is the one conversion from a declaration's
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
const handle = createServer({
  routes: [{ method: 'GET', path: '/posts/:id', meta: { name: 'posts.show', auth: 'public' },
             handler: (req) => json({ id: req.param('id') }) }],
  config: defineHttpConfig({ port: 3000 }),
  role: 'web',
}).start();
```

Static paths are registered in Bun's native `routes` table; param/wildcard paths fall
through to `fetch`. Method resolution stays ours so a 405 still carries problem+json.

## Errors

`X_ROUTE_NOT_FOUND` · `X_METHOD_NOT_ALLOWED` · `X_BODY_INVALID` · `X_UNAUTHENTICATED`
· `X_FORBIDDEN` · `X_RATE_LIMITED` · `X_BUILD_SKEW` · `X_ROUTE_CONFLICT`
· `X_CORS_CONFIG_INVALID` · `X_RATE_LIMIT_NOT_SHARED`

One `factsOf()` feeds three renderings — terminal, `application/problem+json`, dev
overlay — so the `code`/`cause`/`fix` strings can never diverge.

## Boundaries

Tier 2. Imports `@ultimat3/core` and `@ultimat3/schema` only. Authentication and
policy evaluation arrive through `ServerHooks`, declared structurally, because
`@ultimat3/policy` is a sibling tier. There is no plugin API: `Middleware` wraps a
handler, the pipeline is everything else.
