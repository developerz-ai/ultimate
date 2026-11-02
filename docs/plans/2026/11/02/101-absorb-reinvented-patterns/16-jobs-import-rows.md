# 16 — `importRows()`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`jobs`), 0 (`core` registrar).

## Why
Three adopters hand-rolled a bulk import. `exportRows()` (`jobs/src/export.ts:147`) ships the outbound half; nothing ships the inbound half, and no CSV reader exists in the repo (grep: none). The parts that agree are mechanism: quote-aware record boundaries across page reads, a memory bound, a resumable position, a per-row error report. Which columns, what they mean and who may import stay the app's, the line `jobs/src/export-format.ts:4` already draws. A CSV upload loaded whole fails the way `jobs/src/export.ts:8` describes for an export; a retried job re-applies rows from zero.

## Decisions
| Candidate | Outcome |
|---|---|
| Name | `importRows`, the twin of `exportRows`. The earlier `exportJob` name does not exist |
| `entity({ retain })` generating a `PurgeTarget` | **killed.** No adopter count behind it. `purge()` plus one `PurgeTarget` (`jobs/src/purge.ts:32`) over `purgeInBatches` (`jobs/src/purge-batches.ts`) already says it; an entity option only moves the window to a second place and would have to reach down from tier 2 to a tier 3 seam |
| Storage import | no: a structural seam, as `ExportSink` (`jobs/src/export-sink.ts:27`). `StorageDriver.get(key, { range })` (`storage/src/driver.ts:149`) satisfies it |
| Atomic whole-file import | no. A page is a step and a transaction; all-or-nothing on two million rows is the lock this avoids. `maxRowErrors: 0` stops at the first bad page |
| Formula guard on the way in | none. `guardFormula` prefixes on export for a spreadsheet; an import cannot know the prefix was added. Stated in the docs |

## Files to change
- `jobs/src/import.ts` (new) — declaration, factory over `job()`.
- `jobs/src/import-pass.ts` (new) — the page loop, the `export.ts` / `export-pass.ts` split.
- `jobs/src/import-format.ts` (new) — pure: bytes plus carry to records plus next offset; quote-aware; BOM; ndjson and csv over `EXPORT_FORMATS` (`jobs/src/export-format.ts:11`).
- `jobs/src/import-source.ts` (new) — `ImportSource`.
- `jobs/src/import-errors.ts` (new).
- `jobs/src/index.ts:172` — explicit exports.
- `core/src/registrar.ts:84` — `{ factory: 'importRows', pkg: '@ultimat3/jobs', kind: 'job' }`; `scripts/primitive-factories.test.ts` holds it.
- `wiki/Jobs-And-Workflows.md`, `wiki/Error-Codes.md`, `wiki/Storage-And-Uploads.md`, `packages/jobs/README.md`, `packages/jobs/CLAUDE.md`, `docs/idea/20-large-app-readiness.md`.
- `examples/dummy/apps/web/app/posts/jobs/import-posts.ts` (new) beside `export-posts.ts`, round-tripping its CSV, registered in the slice's jobs; `jobs.job.test.ts`.

## Steps
1. `ImportSource`: `stat(key)` answering `{ size }`, `get(key, { range: [first, last] })` answering bytes. A `StorageDriver` satisfies it by having the methods; compile the assignment in `scripts/export-sink.test.ts`'s manner.
2. `importRows<Rec, I>({ name, input, tenant, source: () => ImportSource, key(input), format, columns, schema, handle({ rows, ctx, input }), errors: { sink: () => ExportSink, prefix(input) }, pageBytes?, maxRecordBytes?, maxRowErrors?, rate?, clock?, queue?, retry?, timeout? }) => JobHandle<I>`. Every field mirrors `ExportDefinition` (`jobs/src/export.ts:52`) where one exists; `name` and `tenant` required for the same reasons.
3. One `step.run` per page. Step output `{ offset, rows, rejected, errorPart }` is the checkpoint: a killed attempt resumes at the byte offset. Bytes after the last complete record are re-read next page, so no carry survives between steps. `handle` runs at least once per page: `upsertAll` is the idempotent spelling, documented as `backfill()`'s is.
4. CSV header on page 0 compared to `columns`, both directions, as `encodeExportPage` refuses. A record past `maxRecordBytes` with no boundary is refused rather than buffered.
5. Each record through `schema` (Standard Schema). A refusal becomes `{ line, field, code }` in `<prefix>/errors-NNNNN.ndjson`, keyed by page index so a replayed page overwrites (`jobs/src/export-sink.ts:23`). **Never the rejected value**: the artifact would keep what the app refused, PII included.
6. Past `maxRowErrors` the job ends failed with the report written. Default ceiling 1,000, `0` allowed. The report (`rows`, `rejected`, `parts`, `bytes`) is bounded, for `x jobs show`.

## Error codes
`bun run new-error-code` for each, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_IMPORT_HEADER_MISMATCH` | CSV header differs from `columns` | edit the file's header, or `columns` in `importRows('<name>')`; the cause names missing and undeclared |
| `X_IMPORT_RECORD_TOO_LARGE` | a record past `maxRecordBytes`, usually an unclosed quote | repair the quote at the named offset, or raise `maxRecordBytes` |
| `X_IMPORT_TOO_MANY_ERRORS` | rejected rows past `maxRowErrors` | `x jobs show <id> --json`, read the `errors-*.ndjson` it names, repair and re-enqueue with a new key |

## Tests
- `jobs/src/import-format.test.ts`: a quoted newline and a multi-byte character split across a page boundary, CRLF, BOM, `""` escapes, ndjson short tail. Round trip against `encodeExportPage`.
- `jobs/src/import.job.test.ts`: kill mid-file, resume at the offset; row counts exact and no page handled twice past its checkpoint; error artifact holds no rejected value; ceiling ends failed; `tenant: 'none'` fails closed on a scoped write.
- `examples/dummy/apps/web/app/posts/jobs.job.test.ts`: export then import, same rows.
- Mutation: resume from 0 and the job test fails. `x test job`; `bun test packages/jobs/src/import-format.test.ts`.

## Semver
minor.

## Done when
- `importRows` in `PRIMITIVE_FACTORIES`, manifest row generated, `x jobs show` reports it.
- A file many times `pageBytes` imports with peak memory bounded by `pageBytes` + `maxRecordBytes`, stated with the measured number.
- The reference app round-trips its own export.
