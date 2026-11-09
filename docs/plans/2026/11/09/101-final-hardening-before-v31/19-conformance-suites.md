# 19 — Conformance suites: a custom adapter proves itself with one test file

> Part of [`overview.md`](overview.md). Depends on: [`21`](21-adapter-wiring.md) part A (the port table names the suites). Tier: 5 (`testing`), plus the owning packages' parity tests (deleted here). Two sweeps (9a, 9b).

## Rule
Every row of `ADAPTER_PORTS` ([`21`](21-adapter-wiring.md)) has a `<port>Conformance(factory, options)` exported from `@ultimat3/testing`. It runs against every adapter the framework ships (memory first, then Postgres/Redis/S3/NATS in `*.live.test.ts`). The in-package `*-parity.test.ts` it replaces is deleted: one suite, not two (axiom 1). Enforced by `X_ADAPTER_PORT_INCOMPLETE` ([`21`](21-adapter-wiring.md) part B).

Pattern: `packages/testing/src/job-driver-conformance.ts`, `budget-store-conformance.ts`. A suite asserts behaviour through the port only — never SQL text (`jobs/src/driver-parity.test.ts:1-5` compares SQL text; a third-party driver can prove nothing with that).

## Suites (source to lift → new suite)
| Sweep | Port | Lift from | Subjects |
|---|---|---|---|
| 9a | entity `Repo` / driver | `entity/src/*-parity.test.ts` (16 files) | memory, PGlite, Postgres; plus the toy driver from [`07`](07-entity.md) |
| 9a | `StorageDriver` | `storage/src/driver-contract.test.ts`, `driver-parity.test.ts` | memory, local, S3 |
| 9a | `CacheTier` | `cache/src/tier-parity.test.ts` | lru, memo, redis |
| 9a | `RateLimitStore` | http rate-limit tests | memory, Postgres, Redis ([`08`](08-http.md)) |
| 9a | `AuthAdapter` (+ sub-stores), `AuthServerStore` | `auth/src/adapter-parity*.test.ts`, `authorization-server-store.contract.test.ts` | memory, Postgres |
| 9a | `MailDriver` | `mail/src/driver-parity.test.ts` | memory, log, smtp (fixture), ses, resend (fixtures) |
| 9b | `OutboxStore`, `EventBus`, `StepStore`, `LeaseStore` | jobs parity tests | memory, Postgres, Redis where shipped |
| 9b | `IdempotencyStore`, `MeterStore`, `AuditSink` | `action/src/idempotency-parity.test.ts`, `audit-parity.test.ts` | memory, Postgres |
| 9b | realtime `Transport` | `realtime/src/transport-parity.test.ts` | memory, NATS |
| 9b | ai `Provider`, `VectorStore` | `ai/src/provider-parity*.test.ts` | echo/scripted, openai/anthropic fixtures; memory, pgvector |
| 9b | `IsrStore` | [`14`](14-render.md) tests | memory, storage-backed |
| 9b | `PurgeDriver` | cache cdn tests | noop, cloudflare/fastly fixtures |
| 9b | `ScrapeDriver` | `scraping/src/driver-parity*.test.ts` | fake, local browser (e2e) |
| 9b | notify `InboxStore`/`DigestStore`/`PushDeviceStore`/`PreferenceStore`, `Channel` | `notify/src/*-parity.live.test.ts` | memory, Postgres |
| 9b | `PushSubscriptionStore`, `FailureStore`, `ErrorGroupsStore`, `McpConfirmationStore` | `mcp/src/confirmation-store.contract.test.ts`, pwa/core tests | memory (new where missing), Postgres |
| 9b | `SecretSource`, `SearchIndex`, `UploadScanner`, `SmsTransport` | new ports from [`21`](21-adapter-wiring.md) / [`23`](23-feature-gaps.md) | built-ins + memory |

Est. ~35 files (9a) + ~35 files (9b), net of deleted parity tests.

## Files to change
- `packages/testing/src/<port>-conformance.ts` + `<port>-conformance.test.ts` (memory subject) + `<port>-conformance-<backend>.live.test.ts`.
- `packages/testing/src/index.ts` — named exports, grouped (the barrel is near its ceiling: add `@ultimat3/testing/conformance` subpath instead).
- Deleted: each lifted `*-parity*.test.ts`.
- `packages/testing/README.md`.

## Tests
- Each suite run over memory in `unit`, over real backends in `live` (CI starts every service: Postgres, Redis, NATS, S3).
- A deliberately broken memory adapter (one per suite, in the suite's own test) fails at least one case — a suite that cannot fail is not a suite.

## Done when
- `bun run scripts/adapter-ports.ts` ([`21`](21-adapter-wiring.md)) reports every port with a suite.
