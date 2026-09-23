# 01 — core + schema

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Rule: tier 0 answers the same regardless of the host's time zone, file history, or environment
variables it was never given.

## Files to change

| # | Defect | File:line | Change | Test | Semver |
|---|---|---|---|---|---|
| a | `t.date`, `fromIso` and `coerce` accept non-ISO text (`'March 14, 2026'`, `'3/14/2026'`, `'12'`) and parse it at the host's local midnight, so the result depends on `TZ` | `packages/schema/src/validators.ts:351-361`, `packages/schema/src/iso-date.ts:17-23`, `coerce.ts:59` | One exported ISO-shape predicate in `iso-date.ts`: `^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z\|[+-]\d{2}:?\d{2})?)?$`. Every caller checks it before `new Date` | `iso-date.test.ts` spawns `TZ=America/New_York` and `TZ=UTC` subprocesses (the `flag.test.ts` pattern) and asserts the same refusal set | patch, or major (decision in 18) |
| b | `canonicalJson` renders bigint `5n` and string `'5n'` identically, and `Uint8Array([1])` identically to `{0:1}`, so `fingerprint` collides | `packages/core/src/canonical-json.ts:84` | Tag both as the file already tags `Date`: `BigInt(<digits>)` and `Bytes(<base64>)` as bare tokens | `canonical-json.test.ts`: assert the two inputs are unequal | patch |
| c | `writeMasterKeyFile` applies `mode: 0o600` only when it creates the file, so rotating an existing 0644 key leaves it 0644 | `packages/core/src/secrets-store.ts:89` | Write a temp file at 0600 and `renameSync` it over the target (atomic, and it also serves 10-p) | pre-create at 0644, write, assert `statSync(p).mode & 0o777 === 0o600` | patch |
| d | caller fields are spread after `ts`, `level` and `msg`, so `log.error('x', { level: 'debug' })` changes the emitted level (suspected) | `packages/core/src/logger.ts:316-323` | Spread the caller fields first and the line's own fields last. Rename a colliding caller key to `field.level` rather than dropping it | `logger.test.ts`: the level stays `error`, and the caller value survives under the renamed key | patch |
| e | the dev cursor secret is accepted when no env is set: `isLocal` falls back to `'development'` | `packages/core/src/cursor.ts:52`, `packages/core/src/environment.ts` (`DEFAULT_ENVIRONMENT`) | Export `isLocal(env, { fallback: 'production' })`, the answer `templates/scaffold-auth.ts` already uses. Add a boot assertion `assertNoDevSecretsOutsideLocal()` that `serve.ts` calls (slice 12) and that refuses `usesDevCursorSecret()`. New code `X_DEV_SECRET_IN_PRODUCTION` | `cursor.test.ts`: with no env, the assertion throws | patch |
| f | on SIGTERM the listener closes the moment `/readyz` flips, so Kubernetes endpoints still route to a closed socket and POSTs get a 502 | `packages/core/src/lifecycle.ts:358-362` (`accept` phase), `packages/http/src/server.ts:307-315` | Add a `drain.readinessGraceMs` phase between the readiness flip and `server.stop(false)`. Default `0` in dev and `5000` when `!isLocal`. Read it from `AppConfig` so `config-readers` sees a reader | `lifecycle.test.ts` with a fake clock: `/readyz` answers 503 while the listener still accepts, for `graceMs` | minor |
| h | there is no shared IP-range classifier. `scraping/src/hosts.ts:62` (tier 5) holds the only one, and `jobs` webhook (tier 3, slice 05 f) needs one | new `packages/core/src/address-class.ts` | `classifyAddress(ip) → 'loopback'\|'private'\|'link-local'\|'ula'\|'cgnat'\|'unspecified'\|'public'`, covering IPv4, IPv6 and IPv4-mapped IPv6. Move the logic out of `scraping/src/hosts.ts` so there is **one** copy; scraping imports it | table test over each range, plus `::ffff:127.0.0.1` | minor |
| g | `metrics-text.ts:63` escapes `"` in HELP lines, which Prometheus HELP does not define (suspected) | `packages/core/src/metrics-text.ts:63` | Confirm against the exposition-format spec. If it is wrong, escape only `\` and `\n` | golden HELP line | patch |

## Steps
1. Write the failing tests for a–e first.
2. Register `X_DEV_SECRET_IN_PRODUCTION` with `bun run new-error-code X_DEV_SECRET_IN_PRODUCTION --package core --title '…' --fix 'set CURSOR_SECRET in the environment (x secrets set CURSOR_SECRET <value>)'`.
3. Land a with the decision from slice 18 about patch or major. If it is major, keep a in 18 and ship b–g now.
4. Land f together with slice 13's chart change: the chart's `terminationGracePeriodSeconds` must exceed `readinessGraceMs` plus the drain budget.

## Tests
- `bun test packages/schema/src packages/core/src/canonical-json.test.ts packages/core/src/secrets-store.test.ts packages/core/src/logger.test.ts packages/core/src/cursor.test.ts packages/core/src/lifecycle.test.ts`
- `bun run scripts/config-readers.ts` (the new key needs a reader).

## Done when
- The date predicate gives the same answer under two `TZ` values.
- Key rotation leaves the file at 0600.
- A process with no env refuses the dev cursor secret at boot.
- The readiness grace is observable in a test.
