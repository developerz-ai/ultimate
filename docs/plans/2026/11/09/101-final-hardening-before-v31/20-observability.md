# 20 — Observability: one instrumentation bus, OpenTelemetry semconv everywhere

> Part of [`overview.md`](overview.md). Depends on: package slices 02–18 landed (they touch the same files in earlier sweeps). Tier: 0 (`core`) first, then every emitter. One sweep, four agents by package band.

## Rule
**One subscribe point** (Rails' `ActiveSupport::Notifications` equivalent): `core/src/instrument.ts`, tier 0.
- `instrument(name, payload)`, `subscribe(nameOrPrefix, handler) → unsubscribe`, `subscribed(name)` (a guard before building a payload — zero cost when nobody listens).
- Fired before trace sampling, so subscribers see unsampled traffic.
- Handlers in registration order; a throwing handler propagates (keeps strict N+1 mode working).
- OTLP spans and metrics, the dev recorder, the `/_x` panels and app code are all subscribers — one path, not two.
- Not on the bus: `AuditSink`, `FailureStore` (durable ports, [`21`](21-adapter-wiring.md)); the error-reporter chain (already a list); jobs' `onEnqueued` (internal wake); `publishEvent` (durable domain events, a different thing — say so in the wiki).

Enforced: `X_INSTRUMENT_SLOT_FORBIDDEN` — a guard in the `boundaries` step refusing any exported `set*Observer`/`set*Sink`/single exporter slot in `packages/*/src` (allowlist: none).

## Replaces (all v31-break)
`setStatementObserver` (`db/src/observe.ts:79`; installed only by `x dev` at `cli/src/dev-boot.ts:165`, so **prod has no DB spans**), `setRowObserver` (`entity/src/row-observer.ts:77`), `setCrossTenantObserver` (`entity/src/cross-tenant.ts:31`), `setDecisionSink` (`policy/src/decisions.ts:41`), `recentInvalidations`/`recentTierFailures` ring buffers (`cache/src/invalidate.ts:104`, `cache/src/tier-failures.ts:30`), `configureTelemetry`'s single exporter (`core/src/telemetry.ts:139`, written by `cli/src/dev-boot.ts:154` and `cli/src/otlp-export.ts:54`), `setLogSink` (`core/src/logger.ts:203`). Evidence single slots fail: `realtime/src/live-replicator.ts:162` installs without chaining `previous`.

## Event names and spans
| Event | Span (kind) | Semconv attributes | Today |
|---|---|---|---|
| `http.request` | server | `http.request.method`, `http.response.status_code`, `url.path`, `url.scheme`, `server.address`, `http.route` | old `http.method`/`http.status_code` (`http/src/pipeline.ts:305-311`) |
| `db.statement` | client | `db.system.name=postgresql`, `db.query.text` (parameterised), `db.operation.name`, `db.collection.name` | `db.statement`, only under `x dev` (`db/src/statement-funnel.ts:71-72`, `statement-span.ts:15`) |
| `entity.row`, `entity.bulk`, `entity.cross_tenant` | events | — | single slots |
| `policy.decision` | event | — | single slot |
| `action.invoke`, `query.read` | internal | `ultimate.*` | ok (`action/src/invoke.ts:249`, `query/src/read.ts:200`) |
| `job.enqueue` / `job.perform` | producer / consumer | `messaging.system=ultimate`, `messaging.operation.type`, `messaging.destination.name` | consumer only, no messaging attrs (`jobs/src/worker-run.ts:178`) |
| `ai.llm` | client | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens` | `llm.*` (`ai/src/llm.ts:208-285`) |
| `render.page`, `render.isr.regenerate`, `render.hole` | internal | `http.route` | none |
| `outbound.<vendor>` | client | `server.address`, `http.request.method` | forwards `traceparent`, no span (`core/src/outbound-*.ts`) |
| `mail.deliver`, `storage.<verb>`, `cache.hit`/`cache.miss` (events), `cache.invalidate` | client / events | — | none / single slot |

Also: span `events` capped at 128 with `droppedEventsCount` (`core/src/telemetry.ts:203-300`); skip id/attribute work when no exporter and no subscriber. OTLP **logs** exporter (`/v1/logs`) as a subscriber. Metrics: `job.duration` histogram, `db.client.operation.duration`, `gen_ai.client.token.usage`.

## Files to change
- `packages/core/src/instrument.ts` (new), `telemetry.ts`, `logger.ts`, `otlp.ts`, `otlp-log-exporter.ts` (new), `metrics.ts`, `index.ts` / `exports/observability.ts`.
- Emitters: `db/src/statement-funnel.ts`, `statement-span.ts`, `observe.ts` (delete slot); `entity/src/row-observer.ts`, `cross-tenant.ts`; `policy/src/decisions.ts`; `cache/src/invalidate.ts`, `tier-failures.ts`, tier read path; `http/src/pipeline.ts`; `jobs/src/worker-run.ts`, enqueue path; `ai/src/llm.ts`; `render/src/render-html.ts`, `render-isr*.ts`, `render-stream.ts`; `core/src/outbound-*.ts`; `mail/src/send.ts`; `storage/src/driver.ts` wrapper; `realtime/src/live-replicator.ts`.
- Subscribers: `cli/src/dev-boot.ts`, `cli/src/otlp-export.ts`, `admin` `/_x` panels, `testing/src/job-sim-effects.ts:76-87`.
- Guard: `scripts/instrument-slots.ts` (+ test), registered in the `boundaries` step; `bun run new-error-code X_INSTRUMENT_SLOT_FORBIDDEN …`.
- Docs: `wiki/Observability.md` (instrumentation section, semconv table, "subscribe to every slow query" example), `wiki/Upgrading.md`, `docs/architecture/guards.md` (regenerate).

## Tests
- `core/src/instrument.test.ts`: prefix matching, order, unsubscribe, throw propagates, `subscribed()` false → payload builder never called.
- `db/src/statement-span.test.ts`: a sampled statement emits `db.query.text`, with no `x dev` observer installed.
- `http/src/pipeline.test.ts`: semconv names present, old names absent.
- `core/src/otlp-log-exporter.test.ts`: batch shape against the OTLP JSON schema fixture.
- `scripts/instrument-slots.test.ts`: a fixture exporting `setFooObserver` reds.
- Bench: span overhead with no subscriber ≤ 1 µs (today 2.8 µs).

## Done when
- In a production-mode boot with an OTLP collector fixture, one request through an action that queries Postgres yields an `http.request` server span with a child `db.statement` span using stable semconv names.
