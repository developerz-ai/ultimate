# 🧱 @ultimat3/core

Tier 0. The foundation every other Ultimate package imports and none of them may bypass.
Zero dependencies, zero `@ultimat3/*` imports.

| Owns | Module |
|---|---|
| `UltimateError`, the 3-line rendering, `--json` shape | `errors.ts` |
| code → `{ title, docs }` registry, `registerErrorCodes()` | `error-codes.ts` |
| `Result<T, E>` for boundaries where throwing is wrong | `result.ts` |
| request context on `AsyncLocalStorage` | `context.ts` |
| `Actor` (`user \| service \| agent \| anonymous`) | `actor.ts` |
| typed env validated at boot | `env.ts` |
| `defineConfig()` for `app.config.ts` | `config.ts` |
| runtime roles + `ROLE` resolution | `roles.ts` |
| `Clock` — the only source of "now" | `clock.ts` |
| UUIDv7, nanoid, branded ids | `ids.ts` |
| structured JSON logging + redaction | `logger.ts` |
| OTel-shaped spans, always on, no-op by default | `telemetry.ts` |
| graceful drain, `/healthz`, `/readyz` | `lifecycle.ts` |
| the sockets this process opened, so a self-request is not egress | `listeners.ts` |
| `defineService('orgs', …)` → `ctx.orgs`, rebuilt per actor | `service.ts` |
| the registrar table one same-tier package reaches another through | `registrar.ts` |
| decode → resize → encode, the one image pipeline | `image/` |
| `assertNever`, `invariant` | `assert.ts` |

## Errors are instructions

```ts
throw new UltimateError({
  code: 'X_DB_DRIFT',
  cause: 'table "posts" has column "publish_at" not present in any migration',
  fix: 'x db gen "add publish_at"',
});
```

```text
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

`format()` is always 3 lines (`format({ docs: true })` adds a 4th). `toJSON()` is the `--json`
form: `{ code, title, cause, fix, docs, meta, stack }`. The title comes from the registry, so
the terminal, the browser overlay and `--json` cannot drift.

| Code | Subclass |
|---|---|
| `X_CONFIG_INVALID` | `ConfigInvalidError` |
| `X_ENV_MISSING` | `EnvMissingError` |
| `X_NOT_IMPLEMENTED` | `NotImplementedError` |
| `X_INTERNAL` | `InternalError` |

Your package declares its own codes in `src/errors.ts` and registers them once:
`registerErrorCodes({ X_DB_DRIFT: { title: 'schema differs from migrations' } })`.
Registering a code twice throws `X_ERROR_CODE_DUPLICATE`.

`isUltimateError()` is duck-typed on `Symbol.for('ultimate.error')`, not `instanceof` — that is
how `@ultimat3/schema` (tier 0, cannot import core) still produces matching errors.

## Context

```ts
const ctx = createContext({ actor: agentActor({ id: 'mcp-1', scopes: ['post:publish'] }) });
await runWithContext(ctx, async () => {
  const { actor, locale, tz, logger } = useContext();   // throws X_NO_CONTEXT outside
  await withChildContext({ locale: 'es' }, () => render());
});
```

Concurrent requests never leak into each other. `ctx.logger` carries `requestId` + `traceId`
automatically; so does the root `logger` while a context is active. Add typed services by
augmenting `CtxServices`; reach late-bound ones with `useService<T>('mail')`.

A service that reads the actor (`ctx.posts`, scoped to `ctx.actor.orgId`) registers once with
`defineService('posts', (ctx) => ({ ... }))`, at import time. `createContext` and
`withChildContext` then build it fresh, bound to whichever actor they are constructing a ctx
for — importing the module that calls `defineService` is the registration, the same convention
`registerActions` uses. Passing `services: { posts: ... }` to `createContext` still works and
wins over a registered factory of the same name, for a test that wants to hand in a mock.

A factory runs again on **every** `createContext` / `withChildContext` call and is never cached,
because it closes over the ctx (actor, clock, tz) it was built for. `withChildContext` drops a
factory-managed name from what it carries forward on purpose: only an ad hoc service nobody
registered survives an actor swap unrebuilt.

## Env fails once, completely

```ts
export const env = defineEnv({
  DATABASE_URL: { type: 'url', secret: true },
  PORT:         { type: 'port', default: 3000 },
  STAGE:        { type: 'enum', values: ['dev', 'staging', 'prod'] },
  SENTRY_DSN:   { type: 'url', required: false },
  NATS_URL:     { type: 'url', role: 'sync' },   // only required for ROLE=sync
});
```

Every missing or malformed key is listed in one `X_ENV_MISSING`. `secret: true` keys are
redacted in logs and masked in `checkEnv()` output; `describeEnv()` emits declarations only,
safe for `x.manifest.json`. Omit `required` for required — `required: false` is the only
loosening.

## Time, ids, telemetry, drain

- Never call `Date.now()`. Take a `Clock`; tests pass `frozenClock('2026-07-26T10:00:00Z')`.
- `uuid()` is UUIDv7: time-prefixed, monotonic within a millisecond, never backwards on clock
  skew. `typedId<'post'>()` brands it so a post id cannot be passed where a user id is wanted.
- `withSpan('action.publishPost', fn)` is free until `configureTelemetry({ exporter })`.
  Traces cross process boundaries via `traceparent()` / `parseTraceparent()` — Sentry, Honeycomb
  and OTLP all plug in as a `SpanExporter`.
- `onShutdown(name, hook, { phase })` with phases `accept → inflight → close` under one
  deadline; `readyzPayload()` flips to 503 the moment draining starts, `healthzPayload()` stays
  200 until stopped.
- Anything that opens a socket calls `markListening(server.url.origin)` and releases it on close.
  That is what tells the sealed test network a loopback request is this process, not egress.

## One cursor, everywhere

```ts
encodeCursor({ scope, key: ['2026-01-01T00:00:00.000Z'], id: 'p_9' }); // base64url(body).hmac
decodeCursor(cursor, scope);                                          // or X_CURSOR_INVALID
```

Keyset pagination is the repo's, the read primitive's and the admin's — so the codec is here,
signed once and verified once, and a second one anywhere is the regression `cursor.ts` exists to
prevent. `scope` binds a cursor to one read: the entity plus its filters and sort order for a repo
page, `queryHash(name, input)` for a `query`, the resource for the admin. It is a **required**
argument to `decodeCursor` on purpose — an optional check is one a call site can forget, and a
forgotten one pages a listing with another read's cursor. Replaying one is `X_CURSOR_INVALID`,
never a silently wrong page.

| | |
|---|---|
| Signature | truncated HMAC-SHA256, compared in constant time |
| Secret | `ULTIMATE_CURSOR_SECRET`, or `configureCursorSigning()` at boot. Rotating it invalidates every open cursor |
| Signed, not encrypted | the client already has these rows; what it must not do is *invent* a position |
| `usesDevCursorSecret()` | true while the shipped dev key is in use |

## One image pipeline, everywhere

```ts
probeImage(bytes);                                     // { format, width, height, mimeType }
transformImageBytes(bytes, { width: 640, format: 'jpeg', quality: 80 });
blurDataUrl(bytes);                                    // 16px PNG data: URI, the LQIP
```

`storage` variants, `seo` `<picture>` sources and `pwa` icons are the same three steps —
decode, resize, encode — with different numbers, so there is one implementation and no second
scaler for an icon to grow a halo in. Zero dependencies: no `sharp`, no native module.

| | |
|---|---|
| Decode / encode | PNG and JPEG. `canDecode()` / `canEncode()` publish the real list |
| Probe only | WebP, AVIF, GIF, SVG — measured from the header so `width`/`height` still inline and CLS stays 0 |
| Anything else | `X_IMAGE_UNSUPPORTED`, naming the format and pointing at an `ImageTransformDriver` |
| Ceiling | `MAX_IMAGE_PIXELS` (64MP), checked from the header **before** a byte is allocated |
| Determinism | same bytes + same spec → same output bytes. No clock, no randomness |

Adding a format is a decoder plus an entry in `DECODABLE_FORMATS` / `ENCODABLE_FORMATS` — never a
second dispatch. An unencodable `format` is refused from the spec alone, before the source is
decoded, so a request nothing can write never expands 64 megapixels first.

`image/` is the one place in core allowed past the 200-line target, and only there: a JPEG or PNG
codec is a single algorithm that does not split into smaller responsibilities without inventing
seams. Nothing else in it qualifies, which is why the segment headers (`jpeg-headers.ts`), the SVG
text parse (`probe-svg.ts`) and the colour grammar (`color.ts`) are their own files. The 500-line
hard ceiling applies to all of them.

`image/fixtures.ts` is byte-exact output from Pillow and ffmpeg on purpose: a codec that only round
trips against itself proves nothing. Never regenerate a fixture with our own encoder.
