# 01 — core + schema

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Rule: tier 0 answers the same regardless of the host's time zone, file history, or environment
variables it was never given.

## Files to change

| # | Defect | File:line | Change | Test | Semver |
|---|---|---|---|---|---|
| a | `t.date`, `fromIso` and `coerce` accept non-ISO text (`'March 14, 2026'`, `'3/14/2026'`, `'12'`) and parse it at the host's local midnight, so the result depends on `TZ` | `packages/schema/src/validators.ts:351-361`, `packages/schema/src/iso-date.ts:17-23`, `coerce.ts:59` | One exported ISO-shape predicate in `iso-date.ts`: `^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z\|[+-]\d{2}:?\d{2})?)?$`. Every caller checks it before `new Date` | `iso-date.test.ts` spawns `TZ=America/New_York` and `TZ=UTC` subprocesses (the `flag.test.ts` pattern) and asserts the same refusal set | **major** (18 i) |
| b | `canonicalJson` renders bigint `5n` and string `'5n'` identically, and `Uint8Array([1])` identically to `{0:1}`, so `fingerprint` collides | `packages/core/src/canonical-json.ts:84` | Tag both as the file already tags `Date`: `BigInt(<digits>)` and `Bytes(<base64>)` as bare tokens | `canonical-json.test.ts`: assert the two inputs are unequal | patch |
| c | `writeMasterKeyFile` applies `mode: 0o600` only when it creates the file, so rotating an existing 0644 key leaves it 0644 | `packages/core/src/secrets-store.ts:89` | Write a temp file at 0600 and `renameSync` it over the target (atomic, and it also serves 10-p) | pre-create at 0644, write, assert `statSync(p).mode & 0o777 === 0o600` | patch |
| d | caller fields are spread after `ts`, `level` and `msg`, so `log.error('x', { level: 'debug' })` changes the emitted level (suspected) | `packages/core/src/logger.ts:316-323` | Spread the caller fields first and the line's own fields last. Rename a colliding caller key to `field.level` rather than dropping it | `logger.test.ts`: the level stays `error`, and the caller value survives under the renamed key | patch |
| e | the dev cursor secret is accepted when no env is set: `isLocal` falls back to `'development'` | `packages/core/src/cursor.ts:52`, `packages/core/src/environment.ts` (`DEFAULT_ENVIRONMENT`) | Export `isLocal(env, { fallback: 'production' })`, the answer `templates/scaffold-auth.ts` already uses. Add a boot assertion `assertNoDevSecretsOutsideLocal()` that `serve.ts` calls (slice 12) and that refuses `usesDevCursorSecret()`. New code `X_DEV_SECRET_IN_PRODUCTION` | `cursor.test.ts`: with no env, the assertion throws | patch |
| f | on SIGTERM the listener closes the moment `/readyz` flips, so Kubernetes endpoints still route to a closed socket and POSTs get a 502 | `packages/core/src/lifecycle.ts:358-362` (`accept` phase), `packages/http/src/server.ts:307-315` | Add a `drain.readinessGraceMs` phase between the readiness flip and `server.stop(false)`. Default `0` when `isLocal(env, { fallback: 'production' })` and `5000` otherwise, so a process with no env gets the production grace. Read it from `AppConfig` so `config-readers` sees a reader. Validate in `validateConfig`: a finite integer with `0 ≤ v ≤ 60000` (0 = no grace; fractions refused rather than rounded), else `X_CONFIG_INVALID` naming the key | `lifecycle.test.ts` with a fake clock: `/readyz` answers 503 while the listener still accepts, for `graceMs`. `config.test.ts`: NaN, -1, 1.5 and 60001 are refused, 0 is accepted, and no env yields 5000 | minor |
| h | there is no shared IP-range classifier. `scraping/src/hosts.ts:62` (tier 5) holds the only one, and `jobs` webhook (tier 3, slice 05 f) needs one | new `packages/core/src/address-class.ts` | `classifyAddress(ip) → 'loopback'\|'private'\|'link-local'\|'ula'\|'cgnat'\|'unspecified'\|'public'`, covering IPv4, IPv6 and IPv4-mapped IPv6. Move the logic out of `scraping/src/hosts.ts` so there is **one** copy; scraping imports it | table test over each range, plus `::ffff:127.0.0.1` | minor |
| g | `metrics-text.ts:63` escapes `"` in HELP lines, which Prometheus HELP does not define (suspected) | `packages/core/src/metrics-text.ts:63` | Confirm against the exposition-format spec. If it is wrong, escape only `\` and `\n` | golden HELP line | patch |

## Steps
1. Write the failing tests for a–e first.
2. Register `X_DEV_SECRET_IN_PRODUCTION` with `bun run new-error-code X_DEV_SECRET_IN_PRODUCTION --package core --title 'the development signing secret is in use outside a local environment' --meaning 'CURSOR_SECRET is unset and ULTIMATE_ENV/NODE_ENV is not development or test' --fix 'x secrets edit'` (the scaffold's secrets flow; `new-error-code.ts` takes `--title`, `--fix`, `--meaning`, `--section` and has no `--cause`).
3. a is major (18 i): write its test and code on the 22.0.0 branch, and ship b–h now.
4. Land f together with slice 13's chart change: the chart's `terminationGracePeriodSeconds` must exceed `readinessGraceMs` plus the drain budget.

## Tests
- `bun test packages/schema/src packages/core/src/canonical-json.test.ts packages/core/src/secrets-store.test.ts packages/core/src/logger.test.ts packages/core/src/cursor.test.ts packages/core/src/lifecycle.test.ts`
- `bun run scripts/config-readers.ts` (the new key needs a reader).

## Done when
- The date predicate gives the same answer under two `TZ` values.
- Key rotation leaves the file at 0600.
- A process with no env refuses the dev cursor secret at boot.
- The readiness grace is observable in a test.
