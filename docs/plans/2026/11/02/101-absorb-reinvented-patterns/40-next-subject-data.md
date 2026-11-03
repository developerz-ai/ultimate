# 40-next-subject-data — `subjectExport()`, `subjectErase()`: one person's data, provably found

> Part of [`overview.md`](overview.md). Depends on: [`05-entity-tenant-and-locks.md`](05-entity-tenant-and-locks.md), [`40-next-exercise-pass.md`](40-next-exercise-pass.md). Tier: 0 (`core` registrar), 3 (`jobs`, `action`), 2 (`auth`), 1 (`storage`), 5 (`testing`, `cli`).

## Why
Any serious product with users in many jurisdictions must export or erase one person's data on request. Every team writes this late, by hand, and misses the table added last month. An agent adding a table never thinks of it. No package here has it: `grep -rEi 'data subject|right to be forgotten'` over `packages/` finds nothing relevant. `exportRows()` is one table with an app-chosen filter (`jobs/src/export.ts:147`), `purge()` is by age (`jobs/src/purge.ts:32`). No adopter survey asked for this; the bar is what a serious team needs.
Hard to match: the framework holds every foreign key (`entity/src/relations.ts:188`), storage key and framework table, so "you forgot a table" is a build error, and the proof runs on its own generated data. An ORM plugin can see only what it is told.

## Decisions
| Question | Answer |
|---|---|
| Mechanism or business? (axiom 8) | reach, ordering, resume and proof are mechanism, the same for a bank and a blog. **What happens to each table is the app's**: nothing defaults, no retention window, no law is encoded |
| Primitive | two factories over `job`, the shape of `exportRows`. `PRIMITIVE_FACTORIES` rows |
| One declaration | `defineSubject(members, { key, tables, targets })`, a plain value both factories take |
| Treatment | per table: `'delete'`, `{ anonymize: { col: value } }`, or `{ retain: '<reason>' }`. Reason required; blank refused |
| Opt-in? | yes. No `defineSubject`, no check. Once declared, a new reachable table with no treatment is red |
| Reach | entities with a reference path to the subject, walked by `relationMap()`. A table holding a person's data with no key to them is invisible, and `columns:` lists such a table by hand |
| Framework tables | structural `SubjectTarget`, as `PurgeTarget` is: `authSubjectTarget()` (`auth/src/tables.ts:28,61`), `auditSubjectTarget()` (`action/src/audit-postgres.ts:43`). The app lists them or states `{ retain }` |
| Files | `storageSubjectTarget(disk, keysOf)`; a key list the app supplies |
| Queued job inputs, logs | out of reach, and said so: `x_jobs` inputs age out by `jobs-retention.ts`; the docs state the window is the app's |
| Tenancy | a job per tenant: `tenant: (input) => input.orgId`. Crossing tenants is the app's loop |
| Order | children first, each table a step, so a killed run resumes (and `40-next-job-crash-proof` proves it). A cycle: anonymize the nullable side first |
| Sealed columns | deleted with the row, never exported |
| Who may call it | an `action` the app writes, with its own policy. No route, no MCP tool ships |
| Receipts, identity checks, deadlines | the app's |

## Files to change
- `packages/jobs/src/subject.ts`, `subject-plan.ts`, `subject-export-pass.ts`, `subject-erase-pass.ts`, `subject-errors.ts` (new). `jobs/src/index.ts`.
- `packages/core/src/registrar.ts:84` — rows `subjectExport`, `subjectErase` for `@ultimat3/jobs`; `scripts/primitive-factories.test.ts` holds them.
- `packages/auth/src/subject-target.ts`, `packages/action/src/audit-subject-target.ts`, `packages/storage/src/subject-target.ts` (new); each `index.ts`. Structural, so `jobs` imports none.
- `packages/cli/src/exercise-static.ts` — the static check, under the `exercise` step.
- `packages/manifest/src/build.ts`, `schema.ts`, `diff-work.ts` — a `subjects` row: additive, and a treatment moving to `retain` is a visible diff.
- `packages/testing/src/subject-proof.ts` (new) — `subjectProof(def)`. `testing/src/exercise.ts` runs it for each declared subject.
- `examples/dummy/apps/web/app/settings/subject.ts`, `actions/` (new) — `members` as subject, `delete`, `anonymize` and `retain` each used once; `settings` slice's job test.
- `wiki/Jobs-And-Workflows.md`, new section in `wiki/Entities-And-Migrations.md`, `wiki/Storage-And-Uploads.md`, `wiki/Error-Codes.md`, `docs/idea/20-large-app-readiness.md`, READMEs and CLAUDE.md of `jobs`, `auth`, `action`, `storage`, `testing`.

## API
- `defineSubject(entity, { key: (input) => id, tables: { [entityName]: Treatment }, targets?: SubjectTarget[], columns?: { [entityName]: column } })`.
- `subjectExport({ name, input, subject, tenant, sink: () => ExportSink, prefix(input), format })` (`jobs/src/export-sink.ts:27`): one object per table, one index object naming each table, count and treatment. `subjectErase({ name, input, subject, tenant })` returns `{ tables: { [name]: { deleted, anonymized, retained } } }`.

## Steps
1. `subject-plan`: pure, from `relationMap()` and the declaration. Order; reach; undeclared tables; append-only entities (`entity/src/entity.ts:181`) refused `'delete'`.
2. Passes over repositories, never raw SQL: tenancy, row observer and cache tags keep working, so a deleted row leaves live queries and caches through the path they already watch.
3. Bounded batches through `purgeInBatches`' shape (`jobs/src/purge-batches.ts`); one step per batch.
4. Static check; manifest row.
5. `subjectProof`: `seedGraph` with canaries on the subject's reach; run the erase through `runJobs`; search every entity's rows for the subject's canaries and ids; anything left outside a declared `retain` or `anonymize` fails. Run export likewise: each canary must be present, except sealed.
6. The dummy declaration; fix what it finds.

## Error codes
`bun run new-error-code <CODE> --package jobs --off-socket …`; the proof's code `--package testing`.
| Code | When | Fix |
|---|---|---|
| `X_SUBJECT_TABLE_UNDECLARED` (new) | a table reaches the subject, no treatment; names the reference path | `tables: { <t>: 'delete' }`, `{ anonymize: … }` or `{ retain: '<why>' }` in `defineSubject` |
| `X_SUBJECT_TREATMENT_INVALID` (new) | a blank `retain`, an unknown column, `'delete'` on an append-only entity | names the field; `{ retain: '<why>' }` for an append-only one |
| `X_SUBJECT_CYCLE` (new) | no deletion order, no nullable side | `{ anonymize: { <col>: null } }` needs a nullable column: `x db gen` after making one |
| `X_SUBJECT_ERASE_INCOMPLETE` (new) | the proof found the subject's value after erase; table and column printed | correct `tables:`, then `x exercise --json` |

## Tests
- `jobs/src/subject-plan.test.ts` (unit): order on a diamond; a new table is undeclared; a cycle refused.
- `jobs/src/subject.job.test.ts`: export and erase, killed mid-run, resume, same result. `subject.live.test.ts`: Postgres with composite keys from 05.
- `testing/src/subject-proof.test.ts`: planted misses, each red: an untreated table, an anonymize that left one column, a raw copy of the email in a text column.
- `bun test packages/jobs/src/subject-plan.test.ts`.

## Semver
Minor. Additive factories (`PRIMITIVE_FACTORIES` row additive by the overview's rule), opt-in check, optional manifest key.

## Done when
- In `examples/dummy`, adding a table with a key to `members` turns `x verify` red with that table named.
- After `subjectErase`, no seeded value of the subject remains outside a stated `retain`, proved by the search, on both drivers.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
