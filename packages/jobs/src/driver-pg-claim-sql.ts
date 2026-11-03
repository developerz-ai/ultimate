// The claim: the one statement every worker loop runs, and the only one whose cost is a question of
// how far behind the queue is. Apart from `driver-pg-sql.ts`, which re-exports it, because the plan
// it depends on takes a page to explain. `driver-pg-claim.live.test.ts` holds that plan to account.

import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { COUNTER_BUCKET_MS } from './introspection';

/** What both arms of the claim return: a `JobRow`, read off the updated row `j`. */
const CLAIM_ROW_COLUMNS = `j.id, j.name, j.queue, j.input, j.idempotency_key, j.run_id, j.attempt,
          j.max_attempts, j.state, j.tenant_id, j.last_error, j.claimed_by, j.claims,
          j.traceparent, j.enqueued_by,
          (extract(epoch from j.run_at)     * 1000)::bigint as run_at,
          (extract(epoch from j.visible_at) * 1000)::bigint as visible_at,
          (extract(epoch from j.created_at) * 1000)::bigint as created_at,
          (extract(epoch from j.updated_at) * 1000)::bigint as updated_at`;

const CLAIM_ROW_NAMES = `id, name, queue, input, idempotency_key, run_id, attempt, max_attempts,
       state, tenant_id, last_error, claimed_by, claims, traceparent, enqueued_by, run_at,
       visible_at, created_at, updated_at`;

/**
 * The claim. SKIP LOCKED is the whole design: without it, worker 2 blocks on worker 1's row
 * lock and throughput collapses to one worker. `visible_at` in the predicate reclaims leases
 * abandoned by a crashed worker. `cancelled` is absent from every branch by construction — a
 * cancelled row is terminal, so it is never handed to a worker again.
 *
 * TWO arms over one pick. A `running` row is picked only with a lapsed lease, and one that lapsed
 * on its FINAL attempt (`attempt >= max_attempts` — `isFinalAttempt`, `retry.ts`) is `buried`:
 * settled `dead` here, counted, and answered with its new state so the driver reports it instead
 * of handing it out. Re-claimed, it was an attempt past `max_attempts` every lease, forever — a
 * job that kills its worker took one per visibility timeout and never reached the dead letters.
 * `claimed_by` is cleared with the lease, so the body that stalled rather than died cannot settle
 * the row it lost. A buried row spends a slot of `$2`: the pass after it claims what it displaced.
 * `$5` names the jobs declaring `retry.deadLetter: false`: their rows are buried `failed`.
 *
 * `picked` SEEKS, so a claim costs the same at any backlog. One `state in (...) or running` test
 * over `queue = any(...)` cannot be served in `run_at` order by any index, so it read and sorted
 * every due row, and a queue slowed down exactly when it was behind. Hence two ordered index scans
 * per open queue, due rows and lapsed leases, then an outer sort of at most `2 x limit x queues`
 * rows. The due scan's `state in` is `x_jobs_claim_idx`'s predicate word for word, or the planner
 * cannot prove the index applies; the lapsed scan reads `x_jobs_depth_idx`. Measured 2026-11-02,
 * Postgres 17, 1M `done` rows, a backlog of 100k, shared box (read the ratios): one queue
 * 88-122 ms against 0.8 ms; three queues 130-189 ms against 0.7-0.9 ms; a noop `jobWorker` on 8
 * slots 42-55 jobs/s against 443-493. At a backlog of 1,000 the two are level.
 *
 * Rows a scan locked and the outer `limit` dropped stay locked until the TRANSACTION ends, not the
 * statement. That is correct only because a claim autocommits (`exec()` in `driver-pg.ts` is the
 * pool), so the two coincide; a concurrent claimer may skip them for one poll, which `skip locked`
 * already permits. A claim inside a long transaction would hold them for its whole life.
 *
 * `distinct` because a queue named twice is two laterals over one queue, and a row this statement
 * already locked is not skipped: the repeat would spend `limit` on rows it had already picked.
 */
export const SQL_CLAIM = `
with open as (
  select distinct q.queue
    from unnest($1::text[]) as q(queue)
   where not exists (
     select 1 from x_job_pauses p where p.kind = 'queue' and p.name = q.queue
   )
), picked as (
  select id, exhausted
    from (
      select due.id, due.run_at, due.exhausted
        from open
       cross join lateral (
         select id, run_at, false as exhausted
           from x_jobs
          where queue = open.queue
            and state in ('ready', 'delayed', 'suspended')
            and run_at <= now()
          order by run_at
          limit $2
            for update skip locked
       ) due
      union all
      select lapsed.id, lapsed.run_at, lapsed.exhausted
        from open
       cross join lateral (
         select id, run_at, attempt >= max_attempts as exhausted
           from x_jobs
          where queue = open.queue
            and state = 'running' and visible_at <= now()
            and run_at <= now()
          order by run_at
          limit $2
            for update skip locked
       ) lapsed
    ) candidates
   order by run_at
   limit $2
), buried as (
  update x_jobs j
     set state            = case when j.name = any($5::text[]) then 'failed' else 'dead' end,
         visible_at       = null,
         claimed_by       = null,
         last_error       = '${LEASE_LAPSED_FINAL_ATTEMPT}',
         last_error_stack = null,
         updated_at       = now()
    from picked p
   where j.id = p.id and p.exhausted
  returning ${CLAIM_ROW_COLUMNS}
), counted as (
  insert into x_job_counters (job, bucket_ms, bucket_start, dead, failed, duration_ms)
  select name, ${COUNTER_BUCKET_MS}, date_trunc('minute', now()),
         (count(*) filter (where state = 'dead'))::int,
         (count(*) filter (where state = 'failed'))::int, 0
    from buried
   group by name
  on conflict (job, bucket_ms, bucket_start) do update
     set dead   = x_job_counters.dead + excluded.dead,
         failed = x_job_counters.failed + excluded.failed
), claimed as (
  update x_jobs j
     set state      = 'running',
         attempt    = j.attempt + 1,
         claims     = j.claims + 1,
         claimed_by = $3,
         visible_at = now() + ($4::bigint * interval '1 millisecond'),
         updated_at = now()
    from picked p
   where j.id = p.id and not p.exhausted
  returning ${CLAIM_ROW_COLUMNS}
)
select ${CLAIM_ROW_NAMES} from claimed
union all
select ${CLAIM_ROW_NAMES} from buried
`.trim();
