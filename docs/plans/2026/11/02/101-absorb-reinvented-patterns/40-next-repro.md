# 40-next-repro — `x repro <id>`: a production failure becomes a failing test

> Part of [`overview.md`](overview.md). Depends on: [`10-schema-sensitive-and-rules.md`](10-schema-sensitive-and-rules.md), [`12-core-error-fingerprint.md`](12-core-error-fingerprint.md), [`40-next-exercise-pass.md`](40-next-exercise-pass.md) phase 1; phase 2's counts on [`41-add-operations.md`](41-add-operations.md). Tier: 0 (`core`), 1 (`db`, `flags`), 2 (`entity`), 3 (`action`, `query`), 5 (`cli`, `testing`).

## Why
An agent given a stack trace guesses. A report carries code, operation and ids (`core/src/error-reporter.ts:28,46`); the input, the actor's roles, the flags, the clock and the rows the code read are gone once the request ends (`http/src/stages.ts:328`). `wiki/Known-Gaps.md:113` lists "a failure bundle an agent can act on", built by hand in two surveyed systems.
Jobs are most of the way there: `x_jobs` holds `input`, `last_error` and `last_error_stack`, `x_job_steps` every step's output (`jobs/src/driver-pg-ddl.ts:20,75,203`), and `x jobs show` prints them. Nothing turns that into a test.
Hard to match: a replay needs the typed input, the actor, the frozen clock and an entity layer that can seed exactly what was read. With arbitrary handlers over an arbitrary ORM, the read set is not recoverable; here it passes through one seam.

## Decisions
| Question | Answer |
|---|---|
| Deliverable | a generated test file, because that is what an agent can run, edit and keep. The bundle is its input |
| Time travel | not a recording of execution. Frozen clock, captured actor and flags, captured reads seeded, same input, same build's code when the id matches. A hand-written read passes no repository, so it is not captured, and `X_REPRO_NOT_REPRODUCED` says so |
| Off by default? | yes. `failureCapture: { enabled: false }`: storing user input is the app's decision. `x dev` on. Jobs need no capture: the row exists |
| Which failures | 5xx at `invoke`, for actions and queries. A 4xx is the caller's and has a problem document |
| What is masked | `.sensitive()` (slice 10), `redactKeys` through `redactInput` (`jobs/src/redact-input.ts:10`). `.sealed()` never read. A masked field is listed, and a generated value stands in |
| Where stored | `x_failures` in Postgres, its own connection: the request's transaction rolled back. A capture that fails is logged and never changes the response. Added through the one applier, a row in `packages/cli/src/framework-schema.ts`, so the table exists whether or not capture is on |
| Counts | none here. `x_error_groups` ([`41-add-operations.md`](41-add-operations.md)) owns first seen, last seen and count per fingerprint; `x_failures` holds bundles only, keyed by the same fingerprint. One table per fact |
| Bound | per fingerprint, per hour (default 5); rows and bytes capped per bundle |
| Retention | app-chosen: `failurePurgeTarget()` hands `purge()` a target (`jobs/src/purge.ts:32`). No default window |
| Who reads | whoever holds `DATABASE_URL`, or `--from <file>`. No new route, no MCP tool here |
| `x explain` | no new command: `x errors explain <CODE> --recent` lists captured groups for that code |
| Primitive? | none: a CLI command and a config block |

## Files to change
- `packages/core/src/failure-capture.ts` (new) — ALS buffer: `recordFailureFact`, one `undefined` check when off; the `FailureStore` interface. `core/src/config.ts:213`, `config-failure-capture.ts` (new), `exports/observability.ts`.
- `packages/entity/src/row-observer.ts` — an optional read callback above the driver, sealed fields excluded by `sealedFields`, sensitive columns masked. `entity/src/index.ts`.
- `packages/db/src/failure-store-pg.ts` (new) — DDL, insert on its own connection, read, `failurePurgeTarget()`. `db/src/index.ts`. `packages/cli/src/framework-schema.ts` — the row; both tracked apps' `packages/db/schema/` regenerate.
- `packages/action/src/invoke.ts:77`, `packages/query/src/read.ts` (`runQuery`) — parsed input and actor into the buffer; flush on a 5xx.
- `packages/flags/src/runtime.ts` — evaluated flags into the buffer.
- `packages/cli/src/serve-env.ts` — wiring. `dev-boot.ts` — on in `x dev`.
- `packages/cli/src/cmd-repro.ts`, `cmd-repro-spec.ts`, `repro-bundle.ts`, `repro-job.ts`, `repro-request.ts`, `repro-write.ts` (new), `registry.ts`.
- `packages/cli/src/cmd-errors.ts`, `cmd-errors-spec.ts` — `--recent`.
- `packages/testing/src/repro.ts` (new) — `reproduce(bundle)`: seed the rows, fill what is unread through `seedGraph`, freeze, invoke.
- `examples/dummy/app.config.ts` — enabled; `examples/dummy/apps/web/e2e/repro.e2e.test.ts` (new): a planted 500, then `x repro`.
- `wiki/Known-Gaps.md:113` (row out), `wiki/CLI-Reference.md`, `wiki/Observability.md`, `wiki/Testing.md`, `wiki/Configuration.md`, `wiki/Error-Codes.md`, `docs/ops/03-observability.md`, READMEs and CLAUDE.md of `core`, `db`, `cli`, `testing`.

## Steps
Phase 1, jobs. No capture, no table.
1. `x repro <jobId> [--write] [--json]`: reads through `inspectJob`, masks as `x jobs show` does, writes `<slice>/repro-<short>.job.test.ts`: `runJobs` with the input, completed steps replayed from their output, asserting the same code at the same step.
2. `--verify` runs it and answers `{ reproduced, code, fingerprint }`.

Phase 2, requests.
3. Buffer, read callback, store, wiring. Prove the off path allocates nothing: a test asserts no buffer is created.
4. `x repro <requestId|traceId|fingerprint>`, `--list` by fingerprint: bundles held here, count and last seen read from `x_error_groups`. The generated `.contract.test.ts` seeds captured rows, sets the clock to the failure's instant, invokes as the actor.
5. A different build's bundle still generates, with `build` in the output; a mismatched outcome is the answer, not a crash.

## Error codes
`bun run new-error-code <CODE> --package cli …` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_REPRO_UNKNOWN` (new) | no job, request or trace by that id | `x repro --list --json` |
| `X_REPRO_NOT_REPRODUCED` (new) | it ran and did not fail the same way; names the masked fields, the unread rows and the build | `x repro <id> --json`, then set the listed fields by hand in the written test |
| `X_REPRO_CAPTURE_OFF` (new) | a request id with capture disabled | set `failureCapture: { enabled: true }` in `app.config.ts`; `x errors explain <code>` meanwhile |

## Tests
- `cli/src/repro-job.test.ts` (unit, memory driver): a job failing at step 3 yields a test replaying 1 and 2 and failing at 3; a mutated step name changes the file.
- `core/src/failure-capture.test.ts`: off path; caps; a flush failure leaves the response alone.
- `entity/src/row-observer.test.ts`: reads captured; sealed absent; sensitive masked. `db/src/failure-store-pg.live.test.ts`: survives a rolled-back request.
- `examples/dummy/apps/web/e2e/repro.e2e.test.ts`: a 500 in a real boot, `x repro --write`, `bun test` of the written file fails with the same fingerprint.
- `bun test packages/cli/src/repro-job.test.ts`.

## Semver
Phase 1: minor, a new command. **Phase 2: breaking, one row, its own PR.** `x_failures` lands in every app's committed dump, so `drift` is red (`X_SCHEMA_DUMP_DRIFT`) until regenerated. Upgrading: "`x db gen`, commit `packages/db/schema/`." Capture stays off by default.

## Done when
- A planted 500 goes to a green-to-red test by `x repro <requestId> --write --verify`, with no human step.
- A dead job does the same with capture off.
- No sensitive value appears in the store or the written test: asserted by searching their bytes for a planted secret.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
