# @ultimat3/jobs — the worker's cancellation and suspension rules

Moved out of `packages/jobs/CLAUDE.md` on 2026-11-09 (plan 101, slice 21), verbatim, to keep that
file under its 24 KB ceiling. Each is still a rule: a change that breaks one is a defect.

- **A deadline CANCELS, then fails the attempt**, never the reverse (`raceTimeout`, `withStepTimeout`);
  `ctx.signal` aborts unless the body completed AND its ack landed; steps fence on `ended`.
- **A cancelled runner writes NOTHING** — `put()` in `steps.ts` (`X_ABORTED`) — save a fenced
  `X_DRAINING` on a live attempt (recorded once). The STORE fences the claim (`StepFence`,
  `SQL_STEP_PUT` as `SQL_ACK`: `X_JOB_LEASE_LOST`); `executeJob` passes it.
- **A cancelled body's writes refuse too**, `enqueue` included (`outbox-abandon.test.ts`); a store
  on the pool: a fenced `put` past `X_DRAINING` lands.
- **`traceparent` is stamped at ENQUEUE time, in `outbox.ts`**, under `job-instrument.ts`'s
  producer span (the run's consumer span is its child); an empty `spanId` sends none.
  `job.enqueue` is emitted there, `job.perform` in `worker-run.ts`, once per attempt.
- **Suspension is control flow, and a SHED is not a suspension**: `StepSuspension` →
  `nack({ countsAsAttempt: false, park: true })`; a shed is `countsAsAttempt: false` without `park`,
  stays `ready`, logs `jobs.worker.shed` (no `last_error`). `driver-parity.test.ts`.
- **A wiring throw hands back the run's holdings, and its ROW until `executeJob` starts**
  (`worker-run.ts`), as a failed shed does its job (`worker-admit.ts`).
