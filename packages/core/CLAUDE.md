# @ultimat3/core — agent notes

Tier 0. **Imports no `@ultimat3/*` package.** Everything else depends on this, so a change here
is a change to every package.

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | subclass `UltimateError`; never `throw new Error` |
| New code | add to `CORE_CODE_TITLES` in `error-codes.ts`, else the title is auto-humanised |
| Time | take a `Clock`; `Date.now()` / `new Date()` only inside `clock.ts` |
| Context | never thread `ctx` as a parameter — `useContext()` |
| Exports | add to `src/index.ts` explicitly; no `export *` |
| Files | < 200 LOC, 500 hard ceiling, one responsibility, `kebab-case.ts`, test beside source |

Deliberate cycles (safe — nothing is referenced at module-evaluation time):
`errors.ts ⇄ error-codes.ts`. Keep it that way: no top-level `UltimateError` use in
`error-codes.ts`.

`logger.ts` must not import `context.ts`. `context.ts` injects the ids via
`setLoggerContextFields()`. It **does** import `secret.ts`, one way only: `secret.ts` owns
`REDACTED` so a `Secret` can render it without importing the logger, and `logger.ts` re-exports
the constant so there is still one definition and one public path.

| Concept | Owner | Note |
|---|---|---|
| which deploy this is | `environment.ts` (`ULTIMATE_ENV`) | the twin of `ROLE`; never declare a second env var for it |
| what this process does | `roles.ts` (`ROLE`) | |
| the values | `env.ts` | `checkEnv().values` holds REAL secrets — anything that prints goes through `maskedEnvValues()` |
| `.env.example` | `env-example.ts` | a projection of the schema, never hand-maintained |
| loading `.env` | **Bun**, not us | `envFileCandidates()` documents the measured order; there is no `.env.staging` |
| a value that must not be printed | `secret.ts` | redacted by VALUE; `revealSecret()` is the one way out, on purpose greppable |

Metrics mirror tracing exactly — `metrics.ts` is to `telemetry.ts` what a counter is to a span:
always on, no-op exporter by default, driver on the wire. `runtime-metrics.ts` is the only place
that names a series the deploy chart reads (`http_requests_total`, `connections`, `queue_depth`);
`SCALING_METRICS` keys them by `ScalingSignal` so `roles.ts` and `docker/helm` cannot drift.
Core declares the instruments and never calls them for another package's events. `As of 2026-08`
the recorders are wired, and there is exactly one call site per package — a second one anywhere is
the bug:

| Recorder | The one caller | Why that seam |
|---|---|---|
| `recordRequest` | `@ultimat3/http` `pipeline.ts`, the `finally` around `execute` | every request passes it once, error paths included |
| `recordConnection` | `@ultimat3/realtime` `socket.ts`, `SocketRegistry.add`/`remove` | the only definition of a live connection; close, idle sweep and drain all pass through it, so the gauge cannot leak |
| `recordQueueDepth` | `@ultimat3/jobs` `worker.ts`, throttled inside `tick()` | the worker is the only process that reads its own queue |

`recordJob` has no caller yet — `jobs_total` is declared and not emitted.

`METRICS_PATH` is served by `@ultimat3/cli`'s `metrics-endpoint.ts`, on `METRICS_PORT` (9090) and
**not** on the role's HTTP port: the chart's ingress routes `/` to `web`, so `/metrics` beside
`/healthz` would be the app's route patterns and error rates on the internet. Every role opens it,
including the three that open no other socket — `queue_depth` belongs to one of them.

```bash
bun test                      # from packages/core
bun run typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
- `noPropertyAccessFromIndexSignature` is on — `ctx.services['mail']`, not `.mail`.
- `Ctx` carries a string index signature so apps can augment `CtxServices` for `ctx.posts`.
- Tests that touch the registry, the lifecycle or the listener table must call
  `resetErrorCodes()` / `resetLifecycle()` / `resetListeners()`.
- The error-code registry is process-global and every package fills it once, at import time. A
  test that resets it must take `errorCodeSnapshot()` first and call the returned undo in
  `afterAll` — a reset that is not handed back strips the titles of every package imported before
  that file, and their errors render the humanised fallback (`X_DB_DRIFT: db drift`) for the rest
  of the run. That is a load-order flake: green locally, red on whichever CI ordering hits it.
- Tests that call `configureCursorSigning()` must restore the previous secret.
- `PRIMITIVE_KINDS` is the executable copy of the eight-primitive rule — `PrimitiveKind` derives
  from it, so the list and the type cannot drift. A ninth entry fails `registrar.test.ts`, which
  is the point: a new capability arrives as a factory over an existing primitive (`llm()` returns
  an `action`), never as a new kind.
