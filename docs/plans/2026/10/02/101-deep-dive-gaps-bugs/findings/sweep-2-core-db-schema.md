# Sweep 2 — core, db, schema (files sweep 1 left unread)
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `db` drift / introspect / catalog / dump / generate; `core` config / context / lifecycle /
> otlp / secrets / errors / reporter / registrar / image / client; `schema` node / provider /
> standard / builder; `i18n/framework`, `seo/routes`, `seo/locale-tags`, `storage/driver-s3-region`.
> CONFIRMED = a probe ran. db probes ran on PGlite 0.5.8 (PostgreSQL 18.3) only.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/db/src/generate.ts:180` (`diffTable`; snapshot written `:87`) | a changed `primaryKey` on an existing table emits no statement while the snapshot records the new key | `posts` recorded `['id']`, now `['slug']` → `generateMigration` returns `up: ""`, `down: ""`, snapshot `primaryKey: ["slug"]`. By the file's own comment (`:388-392`) the CLI reads an empty `up` as "nothing changed" and re-records the hash sidecar (CLI side unread) | CONFIRMED | a key arm in `diffTable` (`drop constraint <table>_pkey` / `add primary key`, reversed in `down`), or refuse with `migrationIrreversible`; never record a key no statement produced | `packages/db/src/generate.test.ts` |
| 2 | `packages/db/src/drift.ts:189` (`keyColumnsOf`), `:193` (`compareTable`) | the comment (`:182-188`) says a key on one side only "is a difference the *key* comparison owns"; no key comparison exists | `diffSchema(live pk ['id'], expected pk ['slug'])` → `{ok:true, differences:[]}`; live `[]` vs declared `['id']` the same. The nullability check is skipped for the union of both keys — masked too | CONFIRMED | compare the two key lists; emit a difference with the `alter table` pair as `fix:` | `packages/db/src/drift.test.ts` |

Rows 1 and 2 together: a primary-key change is invisible to the generator **and** to the drift gate.

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 3 | `packages/db/src/schema-dump-table.ts:37`, `catalog-fold.ts:48` | every generated column is dumped `stored` | a Postgres 18 `VIRTUAL` column loads as stored (`attgenerated` `'v'` → `'s'`); load-equals-replay reports equal. Fix: carry `attgenerated` through `CatalogColumn` | CONFIRMED | `packages/db/src/schema-dump.test.ts` |
| 4 | `packages/db/src/introspect-catalog.ts:131` (query `catalog-objects.ts:132`) | triggers not filtered to rendered relations | a trigger on a partitioned table → the dump has `09_triggers/pt.sql`, no `04_tables/pt.sql`; `loadSchemaDump` throws `X_SCHEMA_DUMP_DRIFT`. Fix: the `known.has(…)` filter indexes get at `:98`; name the dropped trigger in `unrendered` | CONFIRMED | `packages/db/src/schema-dump.test.ts` |
| 5 | `packages/db/src/catalog-objects.ts:152` (`unrenderedRows`) | the "closed list" of what the dump cannot spell silently omits objects — against `CatalogUnrendered` ("named rather than dropped", `catalog.ts:125-130`) | `force row level security`, `create statistics`, `set storage external`, a materialized view `with no data` — each absent from the dump and from `unrendered`; round trip "equal" | CONFIRMED | `packages/db/src/schema-dump.test.ts` |
| 6 | `packages/core/src/error-reporter-sentry.ts:118-127` | `meta` and `scope.extra` spread raw into the envelope and `JSON.stringify`d | an error whose `meta` holds a `bigint` or a cycle is never reported (`toJSON()` works — it uses `renderMetaRecord`, `errors.ts:168`). `meta` is spread after `fix` / `docs` / `stack` / `requestId` — `meta: { fix, stack }` overwrites the framework's own. Nothing scrubbed: `meta.password` reaches the envelope | CONFIRMED | `packages/core/src/error-reporter-sentry.test.ts` |
| 7 | `packages/core/src/context.ts:304` | `withChildContext({ signal })` replaces the parent's abort signal; the deadline one line above is merged with `earliest()` | parent aborts → inside the child `ctx.signal.aborted === false`; a per-step signal stops seeing client disconnect and request timeout. Fix: `AbortSignal.any([parent.signal, patch.signal])` | CONFIRMED | `packages/core/src/context.test.ts` |
| 8 | `packages/core/src/config.ts:317`, `:336`, `:348`, `:384`, `config-merge.ts:15`, `config-site.ts:112` | the validator that turns an untyped config into `X_CONFIG_INVALID` throws native `TypeError`s | `locales: null`, `roles: null`, `jobs: null`, `jobs.queues: null`, `cache.tiers: null`, `seo.robots.disallow: [5]` each crash. Pattern to follow: `config-pwa.ts:191` | CONFIRMED | `packages/core/src/config.test.ts` |
| 9 | `packages/core/src/config.ts:304-399` (`validate`) | keys accepted mis-typed, no issue raised | `roles: ['websrv']`, `jobs.backoff: 'linear'`, `database.ssl: 'false'`, `realtime.enabled: 'false'` (truthy strings), `database.driver: 'mysql'`, `theme: 'dark'`, `theme.defaultMode: 'blue'`, `auth.signInPath: 'login'`, `ai.mcp: { path: 'mcp', expose: 'no' }`, `cache.tiers: []`, `jobs.queues: ['', 5]`, `locales: ['EN','en']` — each returns a frozen config. No reader found for `database.ssl`, `jobs.backoff`, `jobs.maxAttempts`, `cache.defaultTtlMs`, `roles` outside `config.ts` (`scripts/config-readers.ts` owns that question; unaudited) | CONFIRMED | `packages/core/src/config.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/core/src/otlp.ts:212` | `anyValue` writes `intValue: String(value)` for any integral number — `1e21` → `"1e+21"`; `NaN` / `Infinity` → `{"doubleValue":null}`. A validating collector rejects the batch; `postOtlp` only warns | CONFIRMED |
| `packages/core/src/otlp.ts:178` | only `OTEL_EXPORTER_OTLP_HEADERS` read; per-signal `…_TRACES_HEADERS` / `…_METRICS_HEADERS` ignored while per-signal `ENDPOINT` / `PROTOCOL` are honoured (`:60`, `:107`) | CONFIRMED |
| `packages/core/src/otlp.ts:99` | generic endpoint joined by string concatenation — a query string swallows the path | CONFIRMED |
| `packages/core/src/registrar.ts:130`, `:108` | `fix: bun add @ultimat3/${kind}` names packages that do not exist (`task`, `mutator`, `route`); `task` is live (`packages/jobs/src/register.ts:64`). Fix: map kind → owning package | CONFIRMED |
| `packages/core/src/image/probe.ts:70-81` | `mif1` alone treated as an AVIF brand — HEIC sniffed as AVIF | CONFIRMED |
| `packages/core/src/image/png-pixels.ts:126`, `:172` | `decodeImage` inflates the whole IDAT stream before any size check — a 194 KB PNG declaring 1×1 inflates 200 MB. Callers: `pipeline.ts:135`, `packages/cli/src/mcp-ui-diff.ts:118`. Fix: `assertPixelBudget` from the header first | CONFIRMED |
| `packages/core/src/image/raster.ts:27-33`, `image/errors.ts:58` | a zero-size header is `X_IMAGE_TOO_LARGE`, fix "raise MAX_IMAGE_PIXELS" — a `const` nobody can raise | CONFIRMED |
| `packages/schema/src/standard.ts:103`, `builder.ts:237` | `result instanceof Promise` is the only async guard — a non-native thenable is read as a success; `parse` returns `undefined`, never throws. Fix: `typeof result?.then === 'function'` | CONFIRMED |
| `packages/schema/src/errors.ts:122`, `:128` | `SchemaError` does not reproduce `UltimateError`: `format()` ignores `{docs}`; `toJSON()` has no `retry` (documented "always present", `packages/core/src/errors.ts:61`); raw `meta` — a `bigint` throws on `JSON.stringify` | CONFIRMED |
| `packages/schema/src/builder.ts:47` (`isPlainObject`) | accepts any non-array object — `t.record(t.number).safeParse(new Map(…))` → `{value:{}}`; `t.object({…optional}).safeParse(new Date())` → `{value:{}}` | CONFIRMED |
| `packages/schema/src/builder.ts:198` (`default`) | the fallback never runs through the schema's own check — `t.number.min(5).default(1)` parses `undefined` → 1; JSON Schema publishes the contradiction | CONFIRMED |
| `packages/schema/src/validators.ts:457` | `t.url` is `URL.canParse` on the raw string — untrimmed whitespace accepted and returned; non-http schemes accepted | CONFIRMED; low on whether the scheme part is intended |
| `packages/db/src/introspect.ts:218`, `:12` | expression index keys dropped by the `pg_attribute` join — a hand-rebuilt index with an extra expression key passes `compareIndexes`. `ColumnDescription.dataType` documented `numeric(12,2)`-style, comes from `information_schema.data_type` (`numeric`, `ARRAY`, `USER-DEFINED`). Fix: `format_type(atttypid, atttypmod)` as `catalog-relations.ts:105` | CONFIRMED |
| `packages/seo/src/locale-tags.ts:19-21` | `ogLocaleTag` keeps the script subtag: `zh-hant-tw` → `zh_Hant_TW`, not `language_TERRITORY` | PLAUSIBLE |
| `packages/core/src/secrets-errors.ts:81` | `SecretsKeyInvalidError`'s fix is always the env export, even when the bad key was read from `.secrets.key`; comment says "no newline", `writeMasterKeyFile` writes one (`secrets-store.ts:131`) | PLAUSIBLE |
| `packages/core/src/image/probe.ts:264-270` | `probeAvif` returns the first `ispe` — for tiled AVIF commonly a tile's | PLAUSIBLE, low |

## Gaps

- `ensureReadOnlyRole` grants `SELECT ON ALL TABLES`, framework `x_*` tables included — documented; whether dev `db.query` should reach `x_*` auth tables is a product question.
- `packages/db/src/dependent-view.ts:133-140` matches `relname` with no schema filter. Reading only.
- `dumpFileName` is case-preserving — tables `Posts` and `posts` collide on a case-insensitive filesystem.
- `writeSecretsFile` uses a plain `Bun.write`; the key file gets temp + rename.
- `otlpTraceRequest`'s comment says spans are "grouped by resource identity"; the code uses the first span's resource.
- A `unique`-flag change on an existing column in `generate.ts` was not checked.

## Not a bug (do not re-open)

- Record issue path uses the entry index — argued at `packages/schema/src/validators.ts:300-313`.
- Object / money parsers strip unknown keys while JSON Schema says `additionalProperties: false` — the published side is the narrower one.
- `.default(x).optional()` drops the default — explicit.
- Discriminated union: enum tags, a `constructor` literal tag, optional tag, refined and nullable members.
- Schema dump round trip byte-equal for: mixed-case and quoted identifiers, serial and identity columns, domain over a check, enum default, `NULLS NOT DISTINCT`, deferrable FK, `NOT VALID` check, column collation, partial expression index, materialized-view index, overloaded functions, disabled trigger, `replica identity using index`, PK with `INCLUDE`, a default calling a function.
- `loadOrder` rejoin and the `NOT_YET` retry loop; `snapshot-json` / `snapshot-parse`; `reapBranches` guards.
- OTLP span exporter `pump` / `drainQueue`, metric exporter `flush`.
- `lifecycle*` logic; `client-flight` / `client-dispatch` / `client-transport` fence and dedup.
- `exifOrientation`, `probeJpeg`, `probeVp8*` bounds; `secrets.ts` envelope (AAD, fresh IV, `kid` before decrypt).
- `driver-s3-region`, `i18n/framework`, `seo/routes`, `listen`, `pool-gauge`, `replica-scope`, `replica-identity`, `unrendered`, `invariant-ddl`, `retype-*`, `pglite-*`.

## Still not read

- `packages/schema/src/validators.ts:1-249`, `discriminated-union`, `char-count`, `money-value` (probed only).
- `packages/db/src/{replica-client,replica-route,generated-column,pglite-turns,pglite-package}`; the helpers `generate.ts` calls (`column-alter`, `index-plan`, `check-ddl`, `foreign-key-plan`).
- Every `*.test.ts` in scope. No live Postgres.
