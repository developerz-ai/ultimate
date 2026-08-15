# The observer seam

One diagnostic seam (`packages/db/src/observe.ts`) that every statement passes through, whether or
not anything is listening. Uninstalled, it costs one property read and one branch — no clock read,
no span, no allocation (axiom 6, [`../idea/18-build-vs-wrap.md`](../idea/18-build-vs-wrap.md)'s
sibling axiom for internal design). `x dev` installs it; `serve.ts` never does.

## The two funnels

Every statement this framework sends to Postgres or PGlite passes through exactly one of two
functions, and both are shaped the same way on purpose — same guard, same event, same order of
operations:

| Driver | Funnel | Feeds it |
|---|---|---|
| `Bun.SQL` | `runOn()`, `packages/db/src/client.ts:132-141` | pool path (`:143-158`), reserved-connection path (`:176-179`) — `withTransaction`, `readOnlyQuery`, ad hoc `client.reserve()` all end up here |
| PGlite | `statement()`, `packages/db/src/pglite.ts:125-131` | queued, in-transaction, and pinned statements — fed by `run()` (`:133-142`) |

Neither funnel is reachable by import from outside `db`; a caller gets to a funnel only by sending
a statement. That is what makes "every statement" a true claim rather than a convention someone can
forget to apply at a new call site — there is no second way to reach Postgres or PGlite.

Not everything that touches the pool is a statement. `pool.reserve()` (`client.ts:167`) and
`driver.close()` (`:189`) pin and release a connection; they carry no SQL and are not observed.
`packages/jobs/src/driver-pg.ts:38-41` is a deliberate non-funnel: the job driver runs its own
`PgExecutor` and does not depend on `@ultimat3/db` at all
(`packages/jobs/CLAUDE.md`), so job traffic is invisible to this seam by design, not by omission.

```ts
async function runOn(driver, fragment): Promise<unknown> {
  const observer = statementObserver();
  if (observer === undefined) return sendOn(driver, fragment); // production path, unchanged
  const expected = expectedQueryLoopReason();
  const attribution = statementAttribution();
  const started = performance.now();
  // ...send, span, and report to `observer.onStatement(...)` on success or failure
}
```

Both funnels read the same three things at the same moment — right before the send, right after it
settles — because a diagnostic that judges a whole request runs long after any of these scopes
closed:

- `statementObserver()` — is anything installed at all. `undefined` in production.
- `expectedQueryLoopReason()` — the innermost `expectedQueryLoop(reason, fn)` this statement was
  issued inside, or `undefined`.
- `statementAttribution()` — the innermost `{entity, op}` pair `postgresRepo` declared around this
  repository call, or `undefined` for hand-written SQL, a migration, a health probe, or queue
  traffic.

## The event

```ts
interface StatementEvent {
  readonly text: string;              // "$1..$n" placeholders, safe to log
  readonly values: readonly unknown[]; // may carry user data — a consumer that logs must redact
  readonly durationMs: number;         // send-to-settle, from performance.now()
  readonly rows: number;               // rows returned or affected; 0 when the statement threw
  readonly error?: unknown;            // already X_DB_UNAVAILABLE, when present
  readonly attribution?: StatementAttribution; // { entity, op }
  readonly expected?: string;          // the expectedQueryLoop() reason, when inside one
}

interface StatementObserver {
  onStatement(event: StatementEvent): void;
}
```

`onStatement` runs synchronously on the caller's stack, after the statement settled. It must not
await and must not issue SQL — a statement sent from inside it would re-enter the funnel and
observe itself. A throw propagates to whoever ran the statement: strict test mode is an observer
that fails the test the N+1 happened in, so `onStatement` swallowing its own throw would make that
impossible. A reporting-only observer (the dev ledger) must not throw.

`setStatementObserver(observer | undefined)` replaces the process-wide singleton — same shape as
`setDbClient`, because what it replaces is ambient rather than threaded through `db()`,
`withTransaction()`, and both drivers as a parameter. One observer, not a list: a fan-out array
would make "which diagnostic saw this statement" order-dependent, and the one consumer that needs
several — the dev server — composes them itself, in its own order, where that order is reviewable.

## Attribution: two scopes, both `AsyncLocalStorage`

The funnel knows the SQL. It does not know that the SQL came from `findById` on `members` — by the
time a statement exists, it has left `postgresRepo` by several stack frames and at least one
microtask (the coalescer's flush, a chunked write loop, a preload's `readByIds`). Two scopes carry
that context down across the `await`s a module-scope variable could not survive:

- **`withStatementAttribution(entity, op, fn)`** (`packages/db/src/attribution.ts`) — wraps each
  repository method in `@ultimat3/entity`'s `postgresRepo`, the last caller that still knows both.
  Nesting keeps the innermost pair: a relation preloaded during `findMany` reads through the
  *related* repository, and that nested read is what its own statement is attributed to.
- **`expectedQueryLoop(reason, fn)`** (`packages/db/src/expected-loop.ts`) — the one way to declare
  a loop of statements deliberate. Not a comment pragma, not a config list of exempt call sites
  (axiom 1: both would put the argument somewhere other than the loop it defends). `reason` is
  required and non-blank — an exemption with no argument is a pragma by another name. What it
  suppresses is a *verdict*, not the statements: they are still sent, still spanned, still visible
  to anything that only measures. Applied at `packages/admin/src/search.ts:54-56` (one indexed
  lookup per search field, argued optimal in the call) and `packages/db/src/migrate.ts:169`.

Both scopes cost nothing when no observer is installed — `withStatementAttribution` checks
`statementObserver() === undefined` and calls `fn()` directly, entering no `AsyncLocalStorage` scope
at all. That is why the pair travels as two plain strings rather than a pre-built
`StatementAttribution` object: allocating one before the branch could decline it would tax every
production statement in the process for a diagnostic that is off.

## The span

`withStatementSpan` (`packages/db/src/statement-span.ts`) wraps the send — nothing else — with an
OTel span named `db.<verb>` (`db.select`, `db.insert`, `db.begin`; low cardinality on purpose) and
one attribute, `STATEMENT_ATTRIBUTE = 'db.statement'`, carrying the full text. It is opened
unconditionally, independent of whether a `StatementObserver` is installed — tracing is always on
in this framework and free until an exporter is configured (`x dev` is what configures one).

Kind `sql` in the timeline panel comes from the span-name prefix, read by
`packages/cli/src/dev-traces.ts:94` off `STATEMENT_ATTRIBUTE` — a rename that only landed in
`statement-span.ts` would leave the timeline grouping span names again with every test still green,
which is why the constant is exported and imported by name rather than restated as a string
literal in the second package. `packages/admin/src/dev/panel-timeline.ts:60-79`'s `repeatedSql`
groups spans with `kind === 'sql'` by `detail` — this is what unblocked it; before the span existed
there was nothing at `kind === 'sql'` to group.

## Two things that read the same statement differently

`repeatedSql` (`panel-timeline.ts`) and `nPlusOne` (also `panel-timeline.ts`, sourced from `x dev`'s
statement ledger) are deliberately two fields, not one, because they answer different questions from
the same stream of `StatementEvent`s:

| | `repeatedSql` | `nPlusOne` |
|---|---|---|
| What | a **measurement**: same SQL text more than once, in the shown request | a **verdict**: shapes that crossed `N_PLUS_ONE_THRESHOLD`, per request |
| Grouped by | raw span detail (SQL text) | fingerprint — `entity.op` when attributed, else `$n`-normalized text |
| Honours `expectedQueryLoop` | no — it is a trace of what happened | yes — an expected loop is still sent and still shown here, but never promoted to a verdict |
| Consumer | the timeline flamegraph, always available once a trace exists | `x dev`'s findings, `/_x`, the browser overlay — the one place an author's `fix:` gets pasted from |

A measurement that started warning would be a second detector, quietly disagreeing with the one
whose fix line ships in the CLI output. Keeping them apart is what lets the timeline show every
loop — expected or not — while only the unexplained ones raise `X_N_PLUS_ONE_QUERY` /
`X_N_PLUS_ONE_WRITE`.

## Why production pays one branch

Nothing above this seam changes shape when it is off:

- `runOn`/`statement` call `sendOn`/`send` directly on the `undefined` branch — the exact call the
  funnel made before the seam existed.
- No `performance.now()` read, no span, no `StatementEvent` allocated, no `AsyncLocalStorage` scope
  entered by either `withStatementAttribution` or `expectedQueryLoop`.
- `packages/db/src/observe.test.ts` pins this directly: with no observer installed, `runOn`'s
  behavior is byte-identical to the pre-seam funnel.

`packages/cli/src/serve.ts` never calls `setStatementObserver` — production installs nothing.
`startDev()` (`packages/cli/src/cmd-dev.ts:90-130`) installs the trace recorder and the statement
ledger's observer in the same breath, before the app loads, so the timeline's SQL rows and the
repeat counts arrive together through one switch rather than two:

```ts
const traces = createTraceRecorder();
configureTelemetry({ exporter: traces.exporter });
const statements = createStatementLedger();
setStatementObserver(statements.observer);
```

`createStatementLedger()` (`packages/cli/src/dev-n-plus-one.ts`) is the one consumer that composes
several concerns behind the single observer slot: it counts statement shapes per `Ctx` in a
`WeakMap` (dies with the request, no sweep needed), skips anything carrying `event.expected`, and
promotes a shape to a verdict exactly once — on the statement that crosses the threshold — logging
one line per request per error code even when several shapes loop. That composition lives entirely
in `cli` (tier 5); `db` (tier 1) knows nothing above `StatementObserver`.

## Related

- [`10-cross-cutting.md`](./10-cross-cutting.md) — tracing, i18n, and the other concerns enforced
  rather than documented.
- [`../idea/18-build-vs-wrap.md`](../idea/18-build-vs-wrap.md) — the axiom-6 shape ("uninstalled
  costs one branch") applied at the dependency-decision level.
- `wiki/N-Plus-One-Detection.md` — the user-facing surface: thresholds, `expectedQueryLoop`
  examples, and the exact `fix:` lines `X_N_PLUS_ONE_QUERY`/`X_N_PLUS_ONE_WRITE` carry.
