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
