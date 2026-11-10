# cli: adapter ports in `runtime.ts` (v31, plan 101 slice 21)

`As of 2026-11-09`. The rule behind `packages/cli/src/runtime-overrides.ts`, `runtime-ports.ts` and
`runtime-port-bindings.ts`.

## The rule

- Every swappable backend is a row of core's `ADAPTER_PORTS`. An app swaps one in exactly one place:
  a field of `export const runtime = { … }` in `apps/<app>/runtime.ts`, typed by
  `import type { RuntimeOverrides } from '@ultimat3/cli/serve'`.
- `PortValues` (in `runtime-overrides.ts`) is one field per row the boot honours. `PortBindings`
  (`runtime-ports.ts`) is a mapped type over `AdapterPortName`: a row core adds is TS2741 in
  `runtime-port-bindings.ts` until it is bound, and a field naming no row is a build error too.
- A binding is one of three: **installed** by the one loop `installPorts(bindings, phase, chosen)` —
  `boot` (clock, secret source: before `app.config.ts` runs `installSecrets()`), `queue` (`startQueue`:
  jobs, event bus, idempotency, meter) or `services` (`startServices`, before `loadApp`: AI gateway,
  audit sink, auth limiter, auth server store, error reporter, mail, MCP confirmation store, notify
  stores, rate-limit store, scrape driver, TOTP guard); **read** as a value where it is used
  (storage, transport, purge, cache tiers, ISR store, images, failure store, push subscription
  store, outbox store — the facade needs both it and the queue); or **pending**, naming the package
  that owes an installer. As of 2026-11-09 no row is pending (the last four landed in wave E). A
  pending row has no `RuntimeOverrides` field: a field the boot cannot honour is the defect the
  seam exists to end.
- Each value is `runtime.ts`'s, else the env default, in one expression (`suppliedOr`). A store the app
  supplied is never swept by the boot's retention job: the sweep expires the boot's own tables only.
- Every installer answers its release; the boot's unwind runs them newest first.
- Every path that reads `runtime.ts` installs its `boot` ports through ONE helper,
  `runtime-boot-ports.ts`'s `installBootPorts`: `startServices`, and `startQueueWithBoot` /
  `openAppQueue` for the queue-only paths (`x jobs`, `x db backfill`, `x auth`, `ROLE=migrate`).

## The last four ports (wave E, 2026-11-09)

- **`authServerStore`, `mcpConfirmationStore`**: `authorizationServer({ store })` and
  `mcpConfirmations({ store })` take `store` OPTIONALLY. Omitted, each reads its package's slot at
  EVERY call, never at construction (`runtime.ts` may import the module that builds one BEFORE the
  boot installs the port — a captured default silently ignored it) — `runtime.ts`'s store, installed in the `services` phase before `loadApp`; else
  the env default, `postgres…Store({ executor: dbExecutor() })` over the ambient pool, exactly the
  line every app wrote by hand. The boot therefore installs only a SUPPLIED value and never imports
  `@ultimat3/mcp` for a role that does not use it (`mcp/src` stays web-only in `serve-graph.test.ts`).
- **`cacheTiers`** (decision): `cache.tiers` in `app.config.ts` still NAMES the ladder. A supplied
  `CacheTier` replaces the rung of its own `name` — built from nothing, so a supplied `redis` tier
  needs no `REDIS_URL` — and the boot builds the other named rungs. A supplied tier the config does
  not name is logged `cache.tier.unnamed` (`source: 'runtime.ts'`) and never registered: the config
  is the declaration, the precedent `REDIS_URL` set and `redis` unnamed already set.
- **`errorReporter`**: installed before `loadApp`; `configureReporting` (`serve-env.ts`) reads
  `installedErrorReporter()` — so the installed reporter IS the app's reporter for the `SENTRY_DSN`
  rule — and installs the chain (app members + its transport) as a FRAME above it, whose release the
  boot's unwind runs. `configureErrorReporting` no longer takes a `reporter`.
- **`storage`**: the field is a `StorageDriver` (the row's interface), not a `Storage`: the boot's
  default disk, registered under the driver's `name`. Several disks are `defineStorage()`, which wins.

## Deleted

- `RuntimeOverrides.syncAuthenticate`: a second identity seam beside `configureAuthenticator`. A
  token's lifetime is `configureAuthenticator(fn, { credentialTtlMs })`, which the sync adapter reads
  (`sync-authenticator.ts`). No adopter used the override (grep of every repo under `~/workspace`).
- `ShotClock` / `systemShotClock`: core's `SleepClock` / `systemClock`; tests use `frozenClock`.

## The scaffold

`x new` writes `apps/web/runtime.ts` with one commented line per row (derived from the table,
`templates/scaffold-runtime-ports.ts`), and its test. `x g sign-in` writes a richer one with the
sign-in guard; it carries `merge: 'replaces-pristine'`, so it replaces the scaffold's copy only while
that copy is byte-for-byte untouched — an edited `runtime.ts` is `X_GENERATE_CONFLICT`.

## x secrets and x doctor

They read the master key from `ULTIMATE_SECRETS_KEY` or `.secrets.key` only, and `x secrets`' summary
says so. Importing `runtime.ts` for its `secretSource` would run the app's boot guards, which may need
the very secrets the command edits.

## The factory lint

`packages/db/factories.ts` exporting `factories` (a `FactorySet`) is the one place an app's factories
live. The `unit` step lints it in a child from the app root (`verify-factories.ts`) — the child shares
the app's copy of `@ultimat3/testing`, and the app's entities never register into the CLI process.
