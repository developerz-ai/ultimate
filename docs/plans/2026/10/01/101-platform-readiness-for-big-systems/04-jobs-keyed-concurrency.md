# 04 — Jobs: one run per key, and the final attempt

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3.

Rule: "at most N runs of this job for this key, fleet-wide" is a declared field. A second login
to one account is prevented by the queue, not by three guards in app code.

Evidence: `job.concurrency` is a plain number (`packages/jobs/src/job.ts:74-82`) and
`limits.ts` knobs are per process (`packages/jobs/src/limits.ts:25-39`). The scraping system
holds "one run per connection" with a queue lock plus a DB lock; the earlier service attempt
used an in-process semaphore per replica.

## Files to change
- `packages/jobs/src/job.ts:74-82` — `concurrency?: number | KeyedConcurrency<I>`.
- `packages/jobs/src/worker-fleet-slots.ts:69` — the lease key. Today one key per job; keyed, it
  is `<job>:<key(input)>`. `LeaseStore.acquire(key, limit, …)` (`packages/jobs/src/leases.ts:18-34`)
  already takes both; no store change.
- `packages/jobs/src/worker.ts:194` — what happens when no slot is granted.
- `packages/jobs/src/job.ts` `JobRunArgs` — add `finalAttempt: boolean`.
- `packages/jobs/src/errors.ts` — `X_JOB_KEY_BUSY`.
- `packages/scraping/src/scrape.ts:103` — the `concurrency` type passes through (slice 09 uses it).
- `packages/jobs/README.md`, `packages/jobs/CLAUDE.md`.

## Steps
1. Shape: `{ key: (input: I) => string, limit: number, whenBusy?: 'wait' | 'fail' }`. `'wait'`
   is the default and is today's behaviour per key: the run stays claimable. This is Solid
   Queue's `limits_concurrency to:, key:, on_conflict:` with one difference: its `duration:` —
   the bound after which a stuck holder stops blocking the key — is not a new field here. The
   lease TTL renewed by the heartbeat (`packages/jobs/src/leases.ts:1-5`) is that bound already,
   and a second number that could disagree with it would be a second way.
2. `whenBusy: 'fail'`: the run settles `failed` with `X_JOB_KEY_BUSY`, its body never runs, and
   it is not retried. Classify the code terminal (`registerErrorRetry`).
3. An empty key string is `X_JOB_DECLARATION_INVALID` at the first enqueue — an empty key is one
   global lock nobody declared.
4. Keep the boot refusal: a driver with no `leases` and a keyed job is
   `X_JOB_CONCURRENCY_UNENFORCEABLE`, as for the plain number.
5. `finalAttempt` is `attempt === retry.maxAttempts` as the runner computes it; read where the
   runner decides dead-letter and pass the same boolean. One surveyed app re-derived it by
   re-asking the retry function in six jobs.
6. `x jobs show` and the `/_x` jobs panel (`packages/admin/src/dev/panel-jobs.ts`) print the key.
7. `bun run manifest`: the job row carries `concurrency.keyed: true` and the limit.

## Tests
- `packages/jobs/src/keyed-concurrency.test.ts` (memory lease store, two workers): same key never
  overlaps; different keys run together; `'fail'` settles without running the body;
  `finalAttempt` is true exactly once.
- `packages/jobs/src/keyed-concurrency.job.test.ts`: the same against the pg driver.
- Command: `bun test packages/jobs/src/keyed-concurrency.test.ts`.

## Done when
- Both suites green; a kill of the holding worker frees the key by lease expiry, asserted.
- `X_JOB_KEY_BUSY` has its `wiki/Error-Codes.md` row.
