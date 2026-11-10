# testing: rule rows moved out of `packages/testing/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a row's
Detail cell as it stood, verbatim, under its Rule cell; the package file keeps a short cell marked
`†`. Where the two disagree, `packages/testing/CLAUDE.md` wins. The older long form is
[`testing.md`](testing.md).

## One `mockFetch`, and it grows

a verb in the match, ordered answers, a pinned dial's name (`mock-route.ts`) and `requestLog` (`request-log.ts`). A stream bound for a real server logs `null` (teeing drains it). `original(input, init)` goes as handed: `tls`, `unix`, `proxy` are in no `Request`. `cassette()`: below

## A page test RENDERS, with no cast

`render-view.ts`: `renderRoute(module, { url, actor })` resolves `load` once and hands `meta` and the page that one object, as every render mode does; `renderView(Component, props)` is one component. Full rule: `docs/history/testing.md`

## `runJobs` says who and what

`{ actor }` is the WORKER's identity (the org stays the job's declared tenant), `{ tenantId }` the enqueuer's row; `executions[n].result` is the body's return. A fresh event bus per fixture. Bodies run on the preload's frozen clock (`ctx.clock`), so a `backfill()` throttle moves `Date.now()` instead of sleeping

## One test double per need

`stub(action \| llm() \| query \| job)` replaces the BODY only (action: `overrideHandler`; query: `overrideRows`, both `./adapter`; job: `handle.run`), so policy, parse, output check and every surface stay real; `swapAdapter(port, impl)` borrows a port's `./adapter` installer. Both are undone by the preload's own hooks (`test-scope.ts`): in a test, after it; outside one, at the file boundary — never an `afterEach` a skipped block could miss

## Per-test state is `per-test-reset.ts`

the app preload's `beforeEach` resets the jobs event bus — only when `@ultimat3/jobs` is already loaded, so the reset never loads it — and `installPerTestReset` installs the test-double scope, so both preloads get it from one call

## A `mock.module` ends with its file

`module-mock-boundary.ts` wraps it (and `vi.mock`/`jest.mock`): the real namespace is snapshotted on a file's first mock, so its top-level code RUNS, and mocked back at the boundary. A preload's mock is left. A real one that throws on load: the next file fails `X_TEST_MODULE_MOCK_UNRESTORABLE`

## Every `e2eTest` is audited

`e2e-a11y.ts` (rules), `e2e-a11y-run.ts` (per-test run, `allow`, dedupe), `ax-node.ts` (the one AX reader); full tree only in `cdp-e2e-page.ts`. No switch; `allow` needs a `because`. Raw tabs: `e2e-a11y-tabs.ts` ([history](../../docs/history/testing.md#a11y-on-raw-tabs))

## The exercise pass runs what is registered

`exercise.ts` (`runExercisePass`): every action, query and job once, its own tenant pair off one `seedGraph`, an actor `exercise-actor.ts` picks, `runExercise` (39) the verdict. Rows COMMITTED. Overrides only via `defineExercise` (blank `off` refused). A job runs ALONE (`exercise-job-run.ts`): a fresh queue, one `tick()`, what it queued left unrun on the caller's queue, never a `drain()`

## A reached job is crash-proven

`exercise-crash.ts`: `crashProof` with the control's input and actor, after the tenant proof; only `diverged` is red (`X_JOB_CRASH_DIVERGED`), its place `crashEffectPlace` (`inside` a step via jobs' `currentStep()`, or `after` one). Its world is `alone`, only its row claimed; a child is an `enqueue:` effect, never run. Committed: job bodies escape a transaction

## Every statement the pass sent is planned

`plan-sweep.ts` (`sweepPlans`): first relation an app table, `PREPARE` in a READ-ONLY transaction, seq/bitmap scans off (sorts too, re-planned, under a limit), judged by `plan-oracle.ts` (keys: `plan-sort-key.ts`, conditions: `plan-conditions.ts`); red = `X_QUERY_UNINDEXED` / `X_QUERY_SORT_UNSERVED` with the `indexes:` entry (`plan-sweep-fix.ts`). `scan:` or `expectedSeqScan` is exempt, listed; credited: a partial unique whose predicate the statement states, equality-then-range index under a limit, every `or` arm a declared index leads, a whole read a keyed join side probes by a declared index (`plan-probes.ts`); no generic plan is `X_QUERY_PLAN_UNAVAILABLE`, never a pass

## A shape that grows with the rows is red

`scale-sweep-run.ts`: two more tenants at `SCALE_SIZES` (2, 8 rows a table), every reached primitive once in each; `judgeScale` (pure) reds `X_QUERY_SCALES_WITH_ROWS`. Under `expectedQueryLoop` it is listed with its reason

## An erase is PROVED, not asserted

`subject-proof.ts` (`subjectProof`, run by cli's `exercise-subject.ts`): canaries in every table, one person erased, every stored row searched; a survivor outside `retain` is `X_SUBJECT_ERASE_INCOMPLETE`, naming table and column, never the value

## A captured failure replays as a test

`repro.ts`: `reproduce(bundle, { driver })` seeds the rows it read, freezes the clock at its instant, invokes as its actor; masked fields are stood in (`repro-stand-in.ts`). An unregistered name ANSWERS as the failure. `reproJob(runJobs, failure)` for a dead job. What `x repro --write` emits

## A vendor's answers are a cassette

`cassette.ts`: replay = one `mockFetch` route per recorded URL, seal kept (`X_CASSETTE_MISSING`, `X_CASSETTE_UNUSED`). Record = `ULTIMATE_CASSETTE=record` + `record.hosts`, refused under `CI` (`X_CASSETTE_RECORD_REFUSED`), headers allow-listed, credential keys masked, bytes scanned before disk (`X_CASSETTE_SECRET`). The request side is never written

## Factory values are DECLARED

`factoriesFor` and `seedGraph` share `seed-graph-values.ts`: default, enum, kind, a `matches()` pattern (schema's `patternSamples`; CHECK read by `seed-graph-patterns.ts`), `$meta.schema` (sampler `require`d on first use), through `$parse`, never the name. `seed-graph*.ts` type-import `entity` only

## `subscribe` is a whole `sync` node, minus the listener

`live-node.ts`; no client store, offline queue or rebase log (`feed.local()` is `undefined`); `settled()` yields by `setImmediate`; a lone subscriber re-snapshots. Full rule: `docs/history/testing.md`

## One write seam

`create()` writes through `persistRow`: the installed `usePersister`, else `entityPersister()` — the entity's own repository on `defaultDriver()`, `$parse` then `insert`, answering the stored row. A lookalike `EntityLike` with nothing installed is `X_TEST_FACTORY_NOT_PERSISTED`

## Associations

`belongsTo(parent, 'fk')` (the `defaults` must name `fk` — that is the compile-time check), `hasMany(child, 'fk')` (keyed on the child's column; children non-enumerable on the answer). The tenant column follows the parent; the tenant-column association resolves first. A two-way pair closes with `extend({ hasMany })`

## A port's contract is shared examples

one suite per interface on `@ultimat3/testing/conformance` (`src/conformance.ts`, off `.`), named as `ADAPTER_PORTS[].conformance`: `behavesLike(<port>Conformance, () => yours)`. The list is the README's suite table; each suite's test runs one deliberately broken adapter that must fail

## The micro-DOM records and does not pretend

`style`/`classList` record, a `document` listener is the documentElement's, `querySelector` skips `this`, the box is 0 until written, `ResizeObserver` never fires itself, attaching a node moves it. Full rule: `docs/history/testing.md`

## The selector grammar is SMALL and REFUSES

`island-selector.ts`: compounds of tag, `#id`, `.class`, `[attr]`, `[attr="value"]`, joined by space or `>`. Anything else is `X_TEST_ISLAND_SELECTOR_UNSUPPORTED` with the offset, never an empty answer

## A `runJobs` pass is a real worker's `tick()`

`fixture-jobs.ts` builds an unstarted `jobWorker` per pass, so admission runs: `concurrency` waits and `whenBusy: 'fail'` refuses (`X_JOB_KEY_BUSY`) exactly as in a fleet. Full rule: `docs/history/testing.md`

## An override `input` is awaited, as the call's actor

`exercise-override-input.ts`: run inside the call's own request, so `useContext().actor` is the seated actor; the one way to a signed input. `async` ones are left out of `x drill`'s load
