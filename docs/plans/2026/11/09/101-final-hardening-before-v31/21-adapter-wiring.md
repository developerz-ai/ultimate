# 21 — Adapter wiring: one table of ports, one place to swap, a build error for gaps

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-entity.md) (driver kit). Tier: 0 (`core/src/registrar.ts`), 5 (`cli`), every package exporting a setter. Two parts: **A** (sweep 8) wiring + deletions; **B** (sweep 10) guard + docs, after [`19`](19-conformance-suites.md).

## Rule (owner, 2026-11-09)
Anything an app may need to swap is an **adapter port**. Extension = adapters + wrapping primitives + subscribing to events ([`20`](20-observability.md)). There is no plugin API (axiom 8, `docs/idea/19-mechanism-not-convention.md:75`).

Every port is a row in a frozen `ADAPTER_PORTS` table in `core/src/registrar.ts` beside `PRIMITIVE_FACTORIES`: port name, owning package, interface name, env default, conformance suite name. For each row:
1. a `RuntimeOverrides` field (`cli/src/runtime-overrides.ts:27`); an app sets it only in `apps/<app>/runtime.ts`;
2. the boot builds the default from env; nothing else selects a backend;
3. the interface and the errors a driver throws are exported from the package's `./adapter` subpath;
4. a `<port>Conformance` in `@ultimat3/testing` ([`19`](19-conformance-suites.md));
5. a section in `wiki/Adapters.md`: "write your own X adapter" — interface, memory reference to copy, conformance one-liner, wiring line.

Enforced (part B): `scripts/adapter-ports.ts`, in the `boundaries` step, raising **`X_ADAPTER_PORT_INCOMPLETE`** for a port missing any of 1–4, an exported setter in a package's `.` barrel, or an interface in some `./adapter` subpath that no row lists.

## Today (as of 2026-11-09)
Six ways to swap a backend: 11 `RuntimeOverrides` fields, ~33 exported `set*`/`configure*`/`install*` slots, 2 constructor arguments, 4 env-presence switches, 1 config enum, `configureAi(…)`. Docs teach the setter the boot refuses: `core/src/config.ts:155`, `wiki/Jobs-And-Workflows.md:707` (17 × `setJobDriver`, 2 × `RuntimeOverrides`), the fixes of `X_JOB_CONCURRENCY_UNENFORCEABLE` and `X_JOB_NOT_CANCELLABLE` all say `setJobDriver(...)`, while `X_RUNTIME_DRIVER_SPLIT` refuses it. Following one error's fix triggers another.

## Part A — files to change
- `packages/core/src/registrar.ts` — `ADAPTER_PORTS`; `registrar.test.ts` pins its rows.
- `packages/cli/src/runtime-overrides.ts`, `runtime-services.ts` (499 lines: the wiring becomes one loop over `ADAPTER_PORTS`), `runtime-queue.ts:193-225`, `runtime-push.ts`, `failure-capture-boot.ts`, `framework-schema.ts` — add slots for the hardwired stores: outbox, event bus, idempotency, meter, failure, push subscription, MCP confirmation, auth server, auth limiter (`runtime-services.ts:394`), TOTP replay (`:400`).
- Delete public setters (become unexported installers the boot calls; test resets move to `@ultimat3/testing`): `setJobDriver` `jobs/src/driver.ts:387`, `setMailDriver` `mail/src/driver.ts:242`, `setEventBus` `jobs/src/events.ts:175`, `setIdempotencyStore` `action/src/idempotency.ts:211`, `setMeterStore` `action/src/meter-store.ts:50`, `setNotifyStores` `notify/src/stores.ts:52`, `setFailureStore` `core/src/failure-capture.ts:90`, `setChannelTransport` `realtime/src/channel-publish.ts:41`, `setScrapeDriver` `scraping/src/driver.ts:106`, `installRateLimitStore` `http/src/rate-limit-installed.ts:30` (+ `adoptRateLimitStore` internal, `httpServer({rateLimitStore})` removed), `configureAuthLimiters`/`configureTotpReplay` `auth/src/limiter-install.ts:52,126`.
- `realtime.transport` / `urlEnv` config and the closed `REALTIME_TRANSPORTS` union (`core/src/config.ts:49,193`) → env default + `runtime.transport` (any `Transport`). `config-removed.ts` gains rows with the instruction.
- `MasterKeySource` closed union (`core/src/secrets-store.ts:30`) → `SecretSource` port (env and file built in; KMS/Vault written by the app).
- Two `AuditSink` interfaces (`core/src/audit.ts:122`, `admin/src/audit.ts:59`) → core's only; admin imports it.
- Clocks: `ScrapeClock` (`scraping/src/clock.ts:10`) + `setScrapeClock:71`, `ShotClock` (`cli/src/browser-launcher-port.ts:107`), `configureFlags({clock})` (`flags/src/runtime.ts:47`) → one `SleepClock` + one ambient clock in `core/src/clock.ts`; `setFrozenClock` stays in testing.
- `configureAuthenticator` (`http/src/hooks.ts:83`) vs `RuntimeOverrides.syncAuthenticate`: keep the authenticator (token expiry as a field), delete the override. Verify no app depends on the override first (adopters A–I: grep).
- Scaffold: `cli/src/templates` writes `apps/<app>/runtime.ts` with commented port lines.
- `config-removed.ts` + every error `fix:` naming a deleted setter → the `runtime.ts` line.

## Part B — files to change
- `scripts/adapter-ports.ts` + test; `scripts/verify.ts` (boundaries host check); `bun run new-error-code X_ADAPTER_PORT_INCOMPLETE --package core …`.
- Each package: `src/adapter.ts` + `package.json` `exports['./adapter']` for packages that own a port.
- `wiki/Adapters.md` (new; one section per port), rewrite of `wiki/Jobs-And-Workflows.md` and the mail/storage/realtime chapters' wiring sections, `wiki/Upgrading.md` (setter → `runtime.ts` table), `docs/architecture/guards.md` (regenerate), `llms.txt` (link `Adapters.md`).

## Tests
- `registrar.test.ts`: `ADAPTER_PORTS` rows frozen and complete.
- `runtime-overrides.test.ts`: each port swapped through `runtime.ts` reaches its consumer (memory fake per port).
- `scripts/adapter-ports.test.ts`: fixtures for each failure kind red; the repo green.
- Scaffold-smoke: generated `runtime.ts` typechecks.

## Done when
- `grep -rn "export function set[A-Z].*\(Driver\|Store\|Bus\|Transport\|Sink\)" packages/*/src --include=*.ts | grep -v test` is empty.
- `bun run scripts/adapter-ports.ts --json` lists every port with all five parts.
