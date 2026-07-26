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

One `factsOf()` feeds three renderings — terminal, `application/problem+json`, dev
overlay — so the `code`/`cause`/`fix` strings can never diverge.

## Boundaries

Tier 2. Imports `@ultimat3/core` and `@ultimat3/schema` only. Authentication and
policy evaluation arrive through `ServerHooks`, declared structurally, because
`@ultimat3/policy` is a sibling tier. There is no plugin API: `Middleware` wraps a
handler, the pipeline is everything else.
