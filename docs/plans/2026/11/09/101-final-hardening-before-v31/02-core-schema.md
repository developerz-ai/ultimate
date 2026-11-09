# 02 — Core and schema: bounded validation, clean exits, error reporting hooks

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-release-policy.md). Tier: 0 (`core`, `schema`). Not here: `core/src/telemetry.ts` and the instrumentation bus ([`20`](20-observability.md)), `core/src/aws-sigv4.ts` ([`04`](04-storage.md)), config unions and secret sources ([`21`](21-adapter-wiring.md)).

## Findings (probed 2026-11-09)
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| K1 | High | `schema/src/standard.ts:134`, `schema/src/validators.ts` | invalid body of 10k items: 566 KiB in → 289 ms sync CPU, 7.2 MiB problem JSON, 3.6 MiB `cause`. Public actions are the attack surface; the client already refuses > 100 issues (`action/src/wire-issues.ts:14`) | `validate(…, { maxIssues })`: stop collecting at the cap, report `issuesTruncated: n`. Default = `MAX_WIRE_ISSUES` (100), moved to schema and imported by action. Non-breaking: `issues` stays an array |
| K2 | Med | `core/src/error-render.ts:56` (`renderCauseValue`), problem rendering | `cause` and `detail` repeat the full text; unbounded | cap `cause` at 4 KiB through one helper; the span `error.message` and log lines use the same capped text |
| K3 | Low | `core/src/lifecycle-signals.ts:47-50` | `process.exit(0)` even after `X_SHUTDOWN_TIMEOUT` abandoned hooks; the platform records a clean exit over half-done writes | exit `70` when any hook timed out; document in `wiki/Operations.md` (or the ops runbook that lists exit codes) |
| K4 | Low | `core/src/cursor.ts:143` | private constant-time `sameSignature` duplicates `core/src/timing-safe-equal.ts:11` (axiom 1; a security primitive with two copies drifts) | call `timingSafeEqual`; delete the copy |
| K5 | Med | `core/src/error-reporter-sentry.ts:149-154` | options are `dsn`, `fetch`, `clientName` only. An adopter wrote 881 lines to get scrub-by-value, drop-by-code and fingerprinting | add `beforeSend(event) => event \| null`, `ignore: (code) => boolean`, `fingerprint: (error) => string[]`, `sampleRate`. Additive. The double-report at boot is [`17`](17-cli-runtime.md) |
| K6 | Low | `core/src/index.ts` (~900 exports, 1,000 lines) | every browser import of `@ultimat3/core` parses the whole graph: `rpc` alone pulls 230 modules incl. `core/src/image/png-pixels.ts` (`node:zlib` warning) | add subpath `@ultimat3/core/client` (wire codes + retry only), following the existing `outbound` subpath in `core/package.json`. Error titles move server-side. The barrel stays (cutting it is v31 noise with no gain) |

## Files to change
- `packages/schema/src/standard.ts`, `validators.ts`, `index.ts` (export the cap) — K1.
- `packages/core/src/error-render.ts`, the problem renderer it feeds — K2.
- `packages/core/src/lifecycle-signals.ts` — K3.
- `packages/core/src/cursor.ts` — K4.
- `packages/core/src/error-reporter-sentry.ts`, `packages/core/README.md` — K5.
- `packages/core/package.json` (`exports`), `packages/core/src/exports/client.ts` (new), `packages/core/src/core-error-codes.ts` — K6.
- `packages/core/CLAUDE.md` — the subpath rule.

## Tests
- `schema/src/standard.large.test.ts` (new): 10k invalid items → ≤ 100 issues, `issuesTruncated` set, < 20 ms; 50k valid items linear (pin ≤ 3 µs/item with slack).
- `core/src/error-render.test.ts`: 100k-char cause rendered ≤ 4 KiB.
- `core/src/lifecycle-signals.test.ts`: a hook past the deadline → exit code 70; a clean drain → 0.
- `core/src/error-reporter-sentry.test.ts`: `beforeSend` returning `null` sends nothing; `ignore('X_FOO')` drops; `fingerprint` lands in the envelope; `sampleRate: 0` sends nothing.
- `scripts/` bundle pin: building an import of `@ultimat3/core/client` contains no `png-pixels`.
- `bun test packages/schema packages/core`

## Done when
- The 10k-item probe answers in < 20 ms with a < 64 KiB problem body.
- `grep -n sameSignature packages/core/src` is empty.
