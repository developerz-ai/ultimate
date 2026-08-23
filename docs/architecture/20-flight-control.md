# Flight control

One tier-0 layer for the five questions every package was answering on its own: **how long to
wait, whether to try again at all, which failures are worth repeating, how many may run at once,
and whether the answer is still wanted.** Six modules in `@ultimat3/core`. `As of 2026-08-23`.

Source anchors are file + symbol. A line number in prose is a second copy of a fact that drifts on
the next edit, and nothing gates it.

## The measured before

Every count below is the one the replacing module's own header records, except the status row —
that one is re-derived, and it finds a copy the header does not name.

| Question | Copies before | Where |
|---|---|---|
| how long to wait | **4 engines, 3 jitter strategies** — and one of the four had no backoff at all | `jobs/retry.ts` (equal), `ai/gateway.ts` (full, `Math.random` inline and so untestable), `realtime/thundering-herd.ts` (full, 0-based attempt), `db/transaction.ts` (none) |
| is this status worth a retry | **2 byte-identical tables** in packages that cannot import each other, and two more answering the same question differently | `cache/purge-http.ts` and `mail/driver-resend.ts`; `ai/gateway.ts`'s `429 \|\| >= 500`; `scraping/error-throws.ts`'s inverted `4xx except 429` |
| how many at once | **3 bounded pools, one of which refuses** | `auth`'s kdf gate (refuses), `ai`'s hive pool, `http`'s `maxInflight`. `scraping`'s pacer was counted as a fourth until 2026-08-23 and is not one: it bounds how OFTEN a navigation starts, not how many run at once — ten proceed concurrently, merely staggered, and it has no `maxConcurrent`, no queue bound and no refusal |
| N callers, one key | **4 dedup mechanisms** | `cache/single-flight.ts`, `realtime`'s `entry.reading`, `auth/jwks.ts`'s `inflight ??=`, `query`'s per-request memo |
| is this answer still wanted | **nothing had it** | a cancelled reload's response could land on top of the one that replaced it |

## The six modules

| Module | Export | Owns |
|---|---|---|
| `backoff.ts` | `backoffDelay(options)` | the one curve. `exponential \| linear \| fixed`, `full \| equal \| none` jitter, `random` injected |
| `retry.ts` | `retryDecision(policy, attempt, error, random?)`, `retry(work, policy, deps)` | the executor `error-retry.ts`'s vocabulary never had |
| `retryable-status.ts` | `isRetryableStatus(status)`, `RETRYABLE_STATUSES` | `{408, 409, 425, 429}` ∪ `{>= 500}` |
| `single-flight.ts` | `createSingleFlight(options?)` | N concurrent callers on one key are ONE run |
| `flight-gate.ts` | `createFlightGate(limits, options?)`, `gateOverloaded(state)` | a ceiling, a bounded queue, and a refusal past it |
| `generation-fence.ts` | `createFence(subject)`, `isSuperseded(error)` | refusing a late answer whose world has moved on |

`classifyThrown` and `statedDelayMs` moved **down** from `@ultimat3/jobs` into
`packages/core/src/error-retry.ts`, verbatim. `@ultimat3/jobs`' `retry-classification.ts` re-exports
them and `retry-classification.test.ts` pins that they are the same *function*, not two functions
that agree today.

## Rules a reader would otherwise get wrong

| Rule | Why |
|---|---|
| **The clamp lands before the jitter** | jittering first and capping after turns `full` into a distribution whose upper half is a single value at `max` — the correlation the jitter exists to remove |
| **`attempt` is 1-based** | the wait after the first failure is `attempt: 1`. `@ultimat3/realtime`'s clients count from 0, so its wrapper maps `attempt + 1`; dropping that shift doubles every reconnect delay in the framework |
| **A non-finite delay is 0, never `NaN`** | `setTimeout(NaN)` fires immediately — a retry loop with no wait at all, which is the failure backoff exists to prevent. `Number(process.env.…)` on an unset variable is how the `NaN` arrives |
| **`jitter` is optional on `backoffDelay` and required on `RetryPolicy`** | a caller that says nothing to the arithmetic gets a schedule it can predict; a caller running a *loop* has to decide, because a retry loop with no jitter is the thundering herd itself |
| **The single-flight deadline frees the KEY, never the work** | the load is the caller's function and nothing here holds a signal that could abort it. Eviction lets the NEXT caller try; the wedged load runs on and its own joiners still get whatever it answers |
| **Eviction is identity-checked, never key presence** | once a deadline can evict, `inflight.delete(key)` from a settling load would drop a *different* load that has not settled, and its joiners would share a promise nothing in the map answers for |
| **A gate slot is handed over on release** | decrementing first lets a caller arriving in the same tick past the ceiling while a waiter's continuation is still a queued microtask — how a "bounded" pool goes over its bound under exactly the load it exists for |
| **Past `maxQueued` the answer is a refusal, not a longer queue** | an unbounded queue converts a load spike into a memory fault and answers it minutes late |
| **The fence compares `!==`, never `<`** | a generation from the future means the caller carried a token from *another* fence, and letting that work land is strictly worse than refusing it |
| **`retry()` never wraps the last error** | an `UltimateError` carries a code, a cause and a runnable `fix:`; a wrapper replaces all three with the fact that something was retried, which no reader can act on |
| **The time budget is checked BEFORE the wait** | a loop that sleeps and then discovers it is out of budget has already spent the caller's deadline on a wait nobody could use |

## Who delegates what

Every row is behaviour-preserving unless the next section names it.

| Package | Site | Delegates | Keeps |
|---|---|---|---|
| `jobs` | `backoffDelayMs` (`retry.ts`) | the curve | `DurationInput` (`'30s'`), `DEFAULT_RETRY`, and the public `jitter: boolean` — `true` maps to `equal`, never `full` |
| `realtime` | `backoffDelay` (`thundering-herd.ts`) | the curve | its 0-based attempt, mapped `attempt + 1`; `JitterMode` is re-exported, never re-declared |
| `db` | `serializationRetryDelayMs` (`transaction-backoff.ts`) | the curve | the two constants and the case for them — `base: 10`, `max: 500`, `full` |
| `ai` | `backoffMs` (`gateway.ts`) | the curve **and** the status table | `RetryPolicy`'s own field names (`baseDelayMs`/`maxDelayMs`), because they are what an app writes in `createGateway({ retry })` |
| `cache` | `purge-http.ts`, `purge-fastly.ts`, `purge-cloudflare.ts` | the status table | the shared HTTP half — one POST with a deadline, and the per-provider key batching. `purge-http.ts` re-exports `isRetryableStatus` rather than importing it twice, so both drivers still read "what a failure means" off one door |
| `mail` | `driver-resend.ts` | the status table | its own transport |
| `cache` | `single-flight.ts` | the whole function | nothing — the module is two `export` lines, kept as the door this package has always published through, so no call site moves |
| `auth` | `kdf-gate.ts` | the gate mechanism | `X_OVERLOADED` through an injected `overflow:`, so core's `X_FLIGHT_GATE_OVERLOADED` never leaves the package and a client reading 503 sees the code it always saw. `KdfGate` stays the declared return type — widening a public signature is not a refactor |
| `auth` | `jwks.ts` | single-flight **and** the fence | its own TTL and unknown-`kid` rate limit. The hand-rolled `inflight ??=` it replaced had no clobber race to fix — one writer installs and one clears, so a replacement can only be created after the incumbent cleared itself. It was replaced for the **deadline**: `AbortSignal.timeout` bounds only the default transport, `options.fetch` is the app's, and a refresh that ignored its signal held the slot forever |
| `jobs` | `retry-classification.ts` | `classifyThrown`, `statedDelayMs` | `nextRetryForError`, which is the job row's park-or-drop decision |

## Behaviour that changed on purpose

| Change | Effect | Blast radius |
|---|---|---|
| `@ultimat3/ai`'s retryable set widened | **408, 409 and 425 join `429` and `>= 500`** | a gateway call that used to fail once on one of those now spends an attempt. Not retrying them was a gap, not a policy — one narrower table in one package is how it stayed invisible |
| `ai`'s jitter rounding `floor` → `round` | a shift of at most 1 ms | the same rounding `jobs` and `realtime` already used |
| `db`'s `withTransaction` re-run **waits** | exponential from 10 ms, cap 500 ms, full jitter, between attempts only | **the default is unchanged**: `retry` absent or `0` waits nothing. Re-running instantly was the deadlock reproduced rather than resolved — both losers wake in the same microsecond and one loses again |
| `auth`'s JWKS refresh gained a deadline | twice its own transport timeout | a refresh that never settles used to hold the shared slot for the life of the process. Worst case is now one duplicate JWKS fetch, and the fence stops the late answer landing in the cache |
| `createCacheStack`'s load gained a deadline | `DEFAULT_LOAD_DEADLINE_MS = 30_000` | anchored to `@ultimat3/http`'s own `requestTimeoutMs`: a `load()` still running at 30 s has no reader left to serve. Written as a literal because `cache` is tier 1 and `http` is tier 2, so the number cannot be imported |

## Refused, with the evidence

Four sites that look like adoptions and are not. Each is a decision, not an omission.

| Site | Why core's version is the wrong shape |
|---|---|
| `ai/hive-pool.ts`'s `runPool` | a gate admits CALLERS, so absorbing this needs `maxQueued >= inputs.length` — the unbounded queue the gate exists to refuse. A hive also owes an outcome **per index**, and a refusal has no index to spell |
| `query/cache.ts`'s `requestMemo` | core evicts on SETTLE, so it dedupes only CONCURRENT callers. The memo pins two SEQUENTIAL reads in one request at `calls === 1`; measured under core it is `calls === 2` |
| `realtime/query-window.ts`'s `entry.reading` | its forced read deliberately BYPASSES the join for gap repair, and core has no "do not join" mode |
| `http`'s `maxInflight` | it sheds outright with `Retry-After` and never queues, so there is no queue for a gate to bound |

**One status table is still outside, and it disagrees.** `httpFailed` in
`packages/scraping/src/error-throws.ts` classifies `status >= 400 && status < 500 && status !== 429`
as `terminal`, so a scraped **408** or **425** is terminal there and retryable everywhere else. It
is not a refusal with a reason — it is the one copy the sweep did not reach, and it is a live
inconsistency rather than a stylistic one. `As of 2026-08-23`.

## `retry()` is exported and has no caller

`As of 2026-08-23`, nothing in `packages/*/src` calls `retry()` or `retryDecision()` — the only
callers are `packages/core/src/retry.test.ts`. `jobs`, `ai` and `db` each keep their own loop and
delegate only the arithmetic and the classification, because each loop owns something core's does
not: a job row's park-or-drop verdict, a provider fallback across candidates, a `BEGIN` that has to
be re-opened.

That is the exact shape `scripts/config-readers.ts` exists to refuse one tier down — **a thing
declared and never wired** — and no check covers an exported *function*. Either a caller arrives or
the executor goes; leaving it is how the framework's most repeated defect gets repeated.

## Enforcement

```sh
bun run flight-copies            # a step of the gate's `unit` check, standalone
bun run flight-copies --json
```

| Refuses | Code |
|---|---|
| a second backoff curve — a factor raised to an attempt and clamped inside one expression | `X_FLIGHT_SECOND_CURVE` |
| a **call** to `Math.random()` in shipped source | `X_FLIGHT_RANDOM_UNINJECTED` |

Matched on **shape**, never on a name: the copy that would do the damage will not be called
`backoffDelay`, exactly as the render-mode copy was not called `RenderMode`. Three signals together
— `**`, a `Math.min` clamp within 160 characters of it, and a multiplication by a roll — because
any one alone is ordinary arithmetic. The first draft keyed on the roll's *name* and read straight
past a copy whose parameter was `r`.

A `random = Math.random` **default parameter** is the injectable seam working correctly and is never
reported; `packages/core/src/backoff.ts` does exactly that. The invoked form is the defect — it was
`packages/ai/src/gateway.ts`, and it made ai's backoff the one engine of four with no test at all,
because there was no way to pin a number.

Pinned at **zero** and enforcing outright: the sweep landed first, so there is no pin table.
`scripts/flight-copies.test.ts` is the build error, and it asserts the real repo non-vacuously — a
scanner that read nothing reports "no copies", which is the answer a clean repo gives too.

## Errors

| Code | Owner | Status | Retry | Raised when |
|---|---|---|---|---|
| `X_FLIGHT_GATE_OVERLOADED` | `core` | 503 | `retry-after` | a gate is at `maxConcurrent` and its queue is at `maxQueued` |
| `X_SUPERSEDED` | `core` | 499 | `terminal` | `fence.guard(issued)` was handed a generation that is no longer current |

`X_FLIGHT_GATE_OVERLOADED` carries `retryAfterSeconds: 1` on its `meta` — the one spelling
`@ultimat3/http`'s `retryAfterOf` reads onto the `Retry-After` header, so a gate refusal and a rate
limit answer a client the same way. One second, because a gate at its ceiling clears in the time
one unit of work takes.

`X_SUPERSEDED` maps to 499 beside `X_ABORTED` because the outcome is the same: nobody is left to act
on the answer. It is classified `terminal` in core's own table rather than through
`registerErrorRetry()` — a module-scope registration would be an import-time side effect this
package must declare in `sideEffects`, and `resetErrorRetry()` in any test would drop it.

Both are in the cross-cutting table in [`04-error-contract.md`](./04-error-contract.md).
