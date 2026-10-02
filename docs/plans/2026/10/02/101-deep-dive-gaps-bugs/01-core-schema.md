# 01 — core, schema

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.
> Row keys (`s1-t01 #4`) resolve through the table in the overview.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/core/src/retry.ts:77`, `:128` | screen `attempts` and `timeBudgetMs` with `finiteCount` | `s1-t01 #4` |
| `packages/core/src/flight-gate.ts:68` | screen `maxConcurrent` / `maxQueued` | `s1-t01` gaps |
| `packages/core/src/context.ts:304` | child signal composes the parent's (`AbortSignal.any`) | `s2-cds #7` |
| `packages/core/src/config.ts:304-399`, `config-merge.ts:15`, `config-site.ts:112` | list-ness / object-ness screened before use; one closed-set or boolean check per key | `s2-cds #8, #9` |
| `packages/core/src/error-reporter-sentry.ts:118-127` | `meta` and `scope.extra` through `renderMetaRecord`; nested under `extra.meta` so framework keys win | `s2-cds #6` |
| `packages/core/src/logger.ts:63-92` | redaction matches credential stems / suffixes and the framework's own `passwordHash`, `tokenHash`, `keyHash` | `s1-sec M2` |
| `packages/core/src/logger.ts:305` | unknown `LOG_LEVEL` refused, as `createLogger({level})` | `s1-t01` gaps |
| `packages/core/src/otlp.ts:99`, `:178`, `:212` | endpoint joined on `url.pathname`; per-signal `…_HEADERS`; `intValue` only for safe integers, non-finite dropped | `s2-cds` low |
| `packages/core/src/registrar.ts:108`, `:130` | `fix:` names the owning package (`task` → `jobs`, `mutator` → `action`, `route` → `render`) | `s2-cds` low |
| `packages/core/src/sampler.ts:142` | `parentbased_always_on` gets its own case | `s1-t01` low |
| `packages/core/src/image/probe.ts:70-81`, `png-pixels.ts:126,172`, `raster.ts:27-33`, `image/errors.ts:58` | AVIF needs `avif` / `avis`; `assertPixelBudget` from the header before inflate; zero size → `imageDecodeFailed` | `s2-cds` low |
| `packages/core/src/secrets-errors.ts:81` | fix branches on `at` | `s2-cds` low |
| `packages/core/src/nearest-name.ts:27` | cutoff scales with length | `s1-t01` low |
| `packages/core/src/host-rules.ts:70` | address-class floor (`classifyAddress`), opt-out named | `s2-sec L1` |
| **new** `packages/core/src/public-cause.ts` | `hasPublicCause(code)` moves down from `packages/http/src/problem-meta.ts:56,136`; http re-imports it | `s2-sec H1` |
| `packages/schema/src/iso-date.ts:22` | day checked against the month | `s1-t01 #5` |
| `packages/schema/src/coerce.ts:15,81,89,115` | `Array.isArray` guard on object / record; each union member tried; decimal-only numerics | `s1-t01 #16` |
| `packages/schema/src/standard.ts:103`, `builder.ts:237` | thenable test, not `instanceof Promise` | `s2-cds` low |
| `packages/schema/src/builder.ts:47`, `:198` | `isPlainObject` requires `Object.prototype` or `null`; `.default()` runs the fallback through `check` at declaration | `s2-cds` low |
| `packages/schema/src/errors.ts:122,128` | `format({docs})`, `retry: 'terminal'`, rendered `meta` | `s2-cds` low |
| `packages/schema/src/validators.ts:457` | `t.url` requires `href`-stable input | `s2-cds` low |

## Steps
1. Bounds first (`retry`, `flight-gate`): copy `packages/core/src/backoff.ts:51-54`. The `retry` NaN case loops forever — write the test with a call cap, not a timeout.
2. `public-cause.ts`: move the predicate and its code list verbatim; `packages/http/src/problem-meta.ts` re-exports nothing — it imports. Export from `packages/core/src/index.ts` by name. Slices 10 (`mcp`, `ai`) adopt it; do not touch them here.
3. Config: follow `packages/core/src/config-pwa.ts:191` and `config-health.ts:42` (`readinessModeIssue`). Every refusal is `X_CONFIG_INVALID` with the key path. Do **not** delete `defaultTimeZone` / `defaultCurrency` / `roles` / `jobs.backoff` here — unread keys are slice 15.
4. Redaction: one matcher shared by `logger.ts` and `packages/action/src/audit-input.ts:71` (slice 06 adopts it). Keep the exact-key list as a fast path.
5. Schema: `iso-date` reuses the rule of `packages/time/src/plain-date.ts:41-48` — schema is tier 0 and cannot import `time`; restate the 12-entry table with a comment naming the twin, and add both to a parity test.
6. `.default()` on a fallback that fails its own schema throws at declaration — grep `packages/schema/src/errors.ts` for `X_SCHEMA_DEFAULT_UNSHAREABLE` and add a sibling code only if that one does not fit.

## Tests
- Each row's own test file is named in its findings row. New files: `packages/core/src/public-cause.test.ts`.
- A date parity table shared by `packages/schema/src/iso-date.test.ts` and `packages/time/src/plain-date.test.ts`.
- `bun test packages/core packages/schema`

## Owned elsewhere
- `packages/core/src/cursor.ts:52` (empty cursor secret) — 2026-09-28 plan, slice 01.
- `packages/core/src/seal-keys.ts:50-59` (one AES key for every purpose, `s1-sec L2`) — owner call, slice 15.
- 15 `app.config.ts` loaders (`s1-arch #2`) — slice 14.

## Done when
- `retry(work, { attempts: NaN })` throws a coded refusal; `t.date.parse('2026-02-30')` refuses.
- `validate()` returns `X_CONFIG_INVALID` — never a `TypeError` — for every input in `s2-cds #8, #9`.
- `hasPublicCause` has one definition (`grep -rn 'hasPublicCause' packages/*/src` shows one `export`).
- `bun run typecheck`, `bun run boundaries` green.
