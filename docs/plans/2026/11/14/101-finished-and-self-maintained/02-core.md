# 02 — Core: events that name their version, and the tier-0 gaps apps wrapped

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-production-hotfixes.md). Tier: 0.

## Files to change
- `packages/core/src/error-reporter-sentry.ts:113-125`, `error-reporter.ts:228` — C1. Tags are `code`, `source`, `service_version`; `release` is the app's build. No framework version: mapping an event to a release means reading the app's lockfile by hand.
- `packages/core/src/` logger boot line + metrics build-info — C1, same fact on logs and metrics.
- `packages/core/src/error-reporter*.ts` redaction — C2. Redacts by key only; one adopter wrote 545 LOC to scrub by value, another ~800 LOC of tracker triage.
- `packages/core/src/define-error.ts` — C3. Does not cover `registerProblemMeta`; two adopters hold 670 and 218 hand-written `UltimateError` classes they cannot migrate.
- `packages/core/src/map-bounded.ts` — C4. No settle-all form (carried from 2026/11/11, adopter G).
- `packages/core/src/` boot warnings — C5. No app-facing role-scoped warning (carried: A9).
- `packages/core/src/outbound*.ts` — C6. No proxy option; one adopter keeps its own HTTP client for that alone, another duplicates the public-dial guard (168 LOC) because it did not find `dial: 'public'`.
- `packages/core/src/` — C7. A repeated-line limiter: first, recovered, count between.

## Steps
1. C1: stamp `framework_version` (read from `@ultimat3/core`'s own `package.json` at build, one constant) as an event tag, a field on the boot log line and a label on the build-info gauge. One source; guard against a second reader.
2. C2: `redact` accepts value matchers (pattern → replacement) declared once in app config and applied to message, extras and breadcrumbs. Mechanism only: the framework ships no patterns beyond its own secrets.
3. C3: `defineError` takes the problem meta; `registerProblemMeta` stays as the lower-level call. Update the `error-declared` guard's printed fix so it is one command per class.
4. C4: `mapBounded(..., { settle: 'all' })` returning per-item outcomes; the default stays fail-fast.
5. C5: `bootWarning({ roles, code, once })`; move H5's warning onto it.
6. C6: `outbound({ proxy })` — a URL or a resolver per request. Proxy transport is mechanism; inventory and rotation stay in the app. Document `dial: 'public'` beside it in `wiki/` where the duplicate guard's author looked.
7. C7: `logRepeated(key)`; adopt in the scheduler tick (H4), LISTEN redial and bus reconnect.

## Tests
- `bun test ./packages/core/src/error-reporter-sentry.test.ts -t 'framework_version'` — the tag is on every event and equals the stamped version.
- `bun test ./packages/core/src/define-error.test.ts`, `./packages/core/src/map-bounded.test.ts`, `./packages/core/src/outbound.test.ts` (proxy through a local CONNECT fixture; a proxied private address is still refused under `dial: 'public'`).
- Property: no secret-shaped value survives `redact` in message, extras or breadcrumbs.

## Done when
- A production event from either deployed app shows `framework_version` in the tracker.
- The two adopters' scrubbing and triage wrappers have a one-line replacement named in their slices ([`46`](46-adopter-g.md), [`44`](44-adopter-e.md)).

## Corrections (2026-11-14, found while executing)
- C1: the version reader already existed (`core/src/version.ts` `frameworkVersion()`); the boot line is `cli/src/serve.ts`, and the label rides `target_info` + the OTLP resource rather than a new gauge.
- C2: no breadcrumbs are sent, so none are redacted; failure capture had its own walk and needed the value pass too.
- C5: the boot wiring is `cli/src/role-start.ts` (`installRoleBootWarnings`); no framework warning moved, since each would change its log line.
- C7: a limiter already existed twice (`outageLog`, jobs' `failureStreak`); C7 became "unify into core's `failureStreak`, adopt at the remaining sites".
