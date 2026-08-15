# N+1 detection

A statement issued once per row of a set — one `findById` per member of a page where one `in`
query would answer, one `insert` per row where one `insertAll` would answer — is the loop this
detector exists to catch. `As of 2026-08`, dev-only: it costs a production process nothing.

## The two codes

| Code | What it means |
|---|---|
| `X_N_PLUS_ONE_QUERY` | a read repeated once per row — `members.findById` called fifty times where one `in` statement would do |
| `X_N_PLUS_ONE_WRITE` | a write repeated once per row — one `insert`, `update` or `delete` per row of a set, where one statement writes all of them |

Both codes are **declared and composed** by `@ultimat3/entity` (`nPlusOne()` in
`packages/entity/src/errors.ts`); nothing else builds the `code`/`cause`/`fix` text, so `x dev`'s
findings, the timeline, the overlay and a failing test all read the identical message.

Who *raises* it is a separate question, and the answer differs by surface:

| Surface | What happens at the threshold |
|---|---|
| `createTestStatements` (`@ultimat3/testing`) | **throws** `nPlusOne(…)` from inside `onStatement`, so the failing line is the loop's own line |
| `x dev` (`packages/cli/src/dev-n-plus-one.ts`) | **records a verdict and logs one warning** per request per code — it never throws, because a reporting-only observer that threw would break the app it is watching |
| `/_x` and the browser overlay | render the recorded verdict; they raise nothing |

`packages/cli/src/statement-loop.ts` is what keeps them identical: it calls `@ultimat3/entity`'s
`nPlusOne` and reads `code`/`cause`/`fix` off the resulting error rather than restating any of it.
Full row, verbatim: [Error codes → Entity and database](Error-Codes#entity-and-database).

## Before / after

```ts
// naive: one statement per row
const authors = [];
for (const post of posts) {
  authors.push(await db.members.findById(post.authorId));
}
```

```ts
// one statement for the page
const page = await db.posts.where({ orgId }).preload('author').page();
```

`preload('author')` is derived from the `references()` column the entity already declares — there
is no separate list of valid relation names to keep in sync, so a name that doesn't resolve to one
is `X_PRELOAD_UNKNOWN_RELATION`, not a silent miss. Detail on preload's own semantics — scoping,
concurrency, projection — is [Batching and preloading](Batching-And-Preloading); the row-by-row
shape it collapses is also covered in [Entities and migrations → Point lookups batch
themselves](Entities-And-Migrations).

The write side's fix is the equivalent bulk call: `db.<entity>.insertAll(rows)`,
`db.<entity>.updateWhere(filter, patch)`, `db.<entity>.deleteWhere(filter)` — named directly in the
error's `fix:` line, keyed off which of the three the loop was.

## How a finding reaches you: four surfaces, one verdict

A statement shape that crosses the threshold inside one request is reported everywhere at once —
never one surface first and the others eventually:

| Surface | Where |
|---|---|
| `x dev`'s findings | printed in the terminal, and in `--json` |
| `/_x/timeline` | the `nPlusOne` field alongside `repeatedSql`, the admin dev panel |
| the browser dev overlay | rendered next to the error as a notice, same code/cause/fix |
| the logger | one `logger.warn` line, per request, per code |

All four read the same `StatementLoopFact` (`packages/cli/src/statement-loop.ts`) built from one
`RepeatedStatement`, so a report can never say something different on one surface than another. The
log line is intentionally coarser than the findings list: a request that loops three different
*shapes* of read still gets one `X_N_PLUS_ONE_QUERY` warning, because a log is read to learn *that*
this request looped — the three shapes themselves are what the other three surfaces are for.

**The threshold** is 5 statements of one shape (`N_PLUS_ONE_THRESHOLD`,
`packages/entity/src/n-plus-one.ts`), and it is the one thing the two detectors genuinely share:
`x dev`'s ledger and `createTestStatements` both import that constant, so neither can be tuned
without the other moving with it.

Everything else about them differs, deliberately:

| | `x dev`'s ledger | `createTestStatements` |
|---|---|---|
| Counting window | one `Ctx` — a `WeakMap` keyed on the request, which dies with it | fixture creation → disposal, including statements sent outside any request |
| At the threshold | records a verdict, logs once per request per code | throws, once per shape |
| `expectedQueryLoop` statements | not counted at all — this ledger *is* the verdict | counted by `count()` and `shapes()`, excluded only from the `unexpected` tally the throw reads |

So a shape can be visible in a test's `shapes()` and absent from `x dev`'s verdict list for the
same run, and neither is wrong: one is measuring, the other is judging.

## The seam it rides on

None of this reaches into the driver. `@ultimat3/db`'s `observe.ts` is a tier-1, process-wide
`StatementObserver` seam — `setStatementObserver(observer)` installs one, `statementObserver()`
reads it — that the two statement funnels (`runOn` in `client.ts`, `statement()` in `pglite.ts`)
call after every statement settles, success or failure. Every call site guards first: read the
accessor, branch on `undefined`, and only build a `StatementEvent` once something is actually
installed. Nothing is allocated on the path when nothing is watching — one property read and one
branch, uninstalled — which is what makes this genuinely free in production (axiom 6): `serve.ts`
never calls `setStatementObserver`, so a production process always takes that branch.

`@ultimat3/entity`'s `postgresRepo` (`packages/entity/src/pg-driver.ts`) is what attaches an
`entity`/`op` pair to each statement, via `withStatementAttribution(entity.$name, op, send)`. It is
the last frame that still knows both a repository is calling `findById` on `members` before the SQL
is compiled — below it there's only text, which is why hand-written SQL and job-queue statements
show up unattributed rather than misattributed.

## Where it installs: dev only

`x dev` — `startDev()` in `packages/cli/src/cmd-dev.ts` — builds a `StatementLedger`
(`createStatementLedger()`, `packages/cli/src/dev-n-plus-one.ts`) and installs its `observer` at
boot, before the app's own modules load, alongside the trace recorder. The ledger keys its
per-shape counts on the request's `Ctx` object in a `WeakMap`, so state dies with the request it
belongs to and nothing needs sweeping. `packages/cli/src/serve.ts` — the production entry point —
never calls `setStatementObserver` at all. There is no flag to disable this in dev and no flag to
enable it in prod; the wiring itself is the switch.

## Silencing a genuine one-per-row loop

Some loops really are optimal one-statement-per-row — a handful of independent indexed lookups is
sometimes cheaper than one unindexed `OR` across all of them. The one way to say so is
`expectedQueryLoop(reason, fn)` (`packages/db/src/expected-loop.ts`):

```ts
// one indexed lookup per search field beats one unindexed OR across all of them
return expectedQueryLoop('search runs one indexed lookup per field', async () => {
  for (const field of fields) hits.push(...(await repo.list({ where: [eq(field, term)] })));
  return hits;
});
```

`reason` is required and must be non-blank, because an exemption with no argument is a pragma with
extra steps and the whole point is that the argument is written down next to the loop it defends. A
blank one throws `X_INVARIANT` at the call, carrying its own repair:

| | |
|---|---|
| Code | `X_INVARIANT` (borrowed from `@ultimat3/core`'s `assert`, not declared by `db`) |
| Cause | `expectedQueryLoop() was given a blank reason, so the loop it silences carries no argument` |
| `fix:` | `pass why the loop is optimal: expectedQueryLoop('one indexed lookup per field', fn)` |

```bash
x errors explain X_INVARIANT --json
```

The scope rides an `AsyncLocalStorage`, so it survives every
`await` inside `fn`, at any depth, and two loops running concurrently never read each other's
reason; nesting keeps the innermost one.

What it suppresses is the **verdict**, not the statement: the SQL still sends, the observer still
sees it, the trace still opens a span. A detector counting repeats is told the author already
reasoned about this one and stays quiet; anything that only measures — the timeline, a span, a
metric — keeps showing the loop exactly as before. The framework's own deliberate loops declare
themselves the same way: `migrate()`/`rollback()` (`packages/db/src/migrate.ts`) apply and reverse
one migration per transaction, one statement at a time, inside a scope naming why.

## Failing the test instead of warning in a terminal nobody is watching

`x dev` warns; CI is not attended. `@ultimat3/testing`'s `statements` fixture
(`createTestStatements`, `packages/testing/src/fixture-statements.ts`) installs the identical
detector in **throw** mode for the length of one test — destructuring `statements` is the whole
opt-in, there is no `strict: true` flag to forget:

```ts
test('the feed reads its authors once', async ({ statements }) => {
  await loadFeed();
  // X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
  // fix: db.posts.preload('author')   # one statement for the whole page
  expect(statements.count('posts.findMany')).toBe(1);
});
```

It counts from the moment the fixture is built, not from a request boundary — a plain unit test
calling `posts.findById(id)` in a loop has no `Ctx` anywhere, and that is exactly the loop this
fixture exists to catch, unlike the dev ledger which only counts inside a request. The verdict
still only counts unexpected statements — an `expectedQueryLoop` scope suppresses the throw the
same way it suppresses the dev warning — while `count()` and `shapes()` report every statement sent,
expected ones included, because a test asserting "this page issues two statements" must not see a
different number depending on who declared what. It throws once per shape, at the statement that
crosses the threshold, so the failing line is the loop's own line rather than a summary at
teardown; `shapes()` still reports the whole loop afterward for a test that caught the error.

## Why this costs production nothing

Three separate facts add up to zero production cost, not one flag: the `observe.ts` seam is
guard-first and allocates nothing uninstalled; `withStatementAttribution` is the same shape,
guarding before it even opens its `AsyncLocalStorage` scope; and `serve.ts` — the only production
entry point — never calls `setStatementObserver`. Turning the detector on is entirely a fact about
which binary is running: `x dev` wires it, `x serve`/`ROLE=web` never do.

## See also

- [Batching and preloading](Batching-And-Preloading)
- [Entities and migrations](Entities-And-Migrations)
- [Error codes](Error-Codes)
- [Testing](Testing)
