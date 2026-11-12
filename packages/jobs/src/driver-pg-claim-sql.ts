// The claim: the one statement every worker loop runs — and its idle twin — and how the pg driver
// reads its answer (`pgClaim`). Apart from `driver-pg-sql.ts`, which re-exports it, because the plan
// it depends on takes a page to explain. `driver-pg-claim.live.test.ts` holds that plan to account.

import type { Clock, PgExecutor } from '@ultimat3/core';
import { nowMs } from './clock';
import type { ClaimedJob, ClaimOptions, JobRecord } from './driver';
import {
  assertClaimBounds,
  assertClaimQueues,
  JOB_EXPIRED,
  LEASE_LAPSED_FINAL_ATTEMPT,
} from './driver';
import type { JobRow, StepRow } from './driver-pg-rows';
import { toJobRecord, toStepRecord } from './driver-pg-rows';
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
 * A claimed row's steps, as `SQL_STEP_LIST` answers each (`toStepRecord` reads both): the attempt
 * replays from these instead of listing them in a second round trip. A seek on the steps' primary
 * key per claimed row — an empty one on a first attempt.
 */
const STEP_FIELDS = `'run_id', s.run_id, 'name', s.name, 'status', s.status, 'output', s.output,
           'attempts', s.attempts, 'error', s.error, 'event', s.event,
           'correlation_key', s.correlation_key,
           'started_at',   (extract(epoch from s.started_at)   * 1000)::bigint,
           'completed_at', (extract(epoch from s.completed_at) * 1000)::bigint,
           'wake_at',      (extract(epoch from s.wake_at)      * 1000)::bigint`;

/**
 * When a claim that took NOTHING can next take something (`ClaimOptions.onEmpty`), in ms from the
 * database's own `now()`: the earliest waiting row by `run_at` — one seek of `x_jobs_claim_idx`
 * per open queue — and the earliest lease to lapse over the queue's running rows, which are only
 * as many as the fleet holds. Null when neither exists. A paused queue is not `open`: its rows
 * are no due time, and its resume announces itself.
 */
const HORIZON = `select (extract(epoch from (min(n.at) - now())) * 1000)::bigint
     from open
    cross join lateral (
      (select j.run_at as at
         from x_jobs j
        where j.queue = open.queue and j.state in ('ready', 'delayed', 'suspended')
        order by j.run_at
        limit 1)
      union all
      select min(greatest(j.visible_at, j.run_at))
        from x_jobs j
       where j.queue = open.queue and j.state = 'running'
    ) n`;

/** The row `SQL_CLAIM_IDLE` adds when nothing was taken: every claim column null, then the horizon. */
const HORIZON_ARM = `
union all
select ${CLAIM_ROW_NAMES.replace(/[a-z_]+/g, 'null')}, null, (${HORIZON})
 where not exists (select 1 from taken)`;

/**
 * The claim. SKIP LOCKED is the whole design: without it, worker 2 blocks on worker 1's row
 * lock and throughput collapses to one worker. `visible_at` in the predicate reclaims leases
 * abandoned by a crashed worker. `cancelled` is absent from every branch by construction — a
 * cancelled row is terminal, so it is never handed to a worker again.
 *
 * TWO outcomes of one pick, in ONE update (`taken`). A `running` row is picked only with a lapsed
 * lease, and one that lapsed on its FINAL attempt (`attempt >= max_attempts` — `isFinalAttempt`,
 * `retry.ts`) is BURIED: settled `dead` here, counted, and answered with its new state so the
 * driver reports it instead of handing it out. One update, not one per outcome: each statement
 * over `x_jobs` is planned against every index the table has, on every claim (`prepare: false`). Re-claimed, it was an attempt past `max_attempts` every lease, forever — a
 * job that kills its worker took one per visibility timeout and never reached the dead letters.
 * `claimed_by` is cleared with the lease, so the body that stalled rather than died cannot settle
 * the row it lost. A buried row spends a slot of `$2`: the pass after it claims what it displaced.
 * `$5` names the jobs declaring `retry.deadLetter: false`: their rows are buried `failed`.
 * A waiting row past its `expires_at` (`EnqueueRequest.expiresAt`) is buried too — `exhausted`,
 * and `expired` says why: settled `failed` with `JOB_EXPIRED` and reported with the others. Lazy
 * on purpose: decided only for a row the claim already picked, so it costs no index and no sweep.
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
 *
 * A claimed row carries its run's steps (`STEP_FIELDS`, `ClaimedJob.steps`), so an attempt replays
 * without a second round trip to list them; a buried row carries none.
 */
const claimSql = (horizon: boolean): string =>
  `
with open as (
  select distinct q.queue
    from unnest($1::text[]) as q(queue)
   where not exists (
     select 1 from x_job_pauses p where p.kind = 'queue' and p.name = q.queue
   )
), picked as (
  select id, exhausted, expired
    from (
      select due.id, due.run_at, due.expired as exhausted, due.expired
        from open
       cross join lateral (
         select id, run_at,
                coalesce(state <> 'suspended' and expires_at <= now(), false) as expired
           from x_jobs
          where queue = open.queue
            and state in ('ready', 'delayed', 'suspended')
            and run_at <= now()
          order by run_at
          limit $2
            for update skip locked
       ) due
      union all
      select lapsed.id, lapsed.run_at, lapsed.exhausted, false as expired
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
), taken as (
  update x_jobs j
     set state            = case when not p.exhausted then 'running'
                                 when p.expired then 'failed'
                                 when j.name = any($5::text[]) then 'failed' else 'dead' end,
         attempt          = j.attempt + (not p.exhausted)::int,
         claims           = j.claims + (not p.exhausted)::int,
         claimed_by       = case when p.exhausted then null else $3 end,
         visible_at       = case when p.exhausted then null
                                 else now() + ($4::bigint * interval '1 millisecond') end,
         last_error       = case when p.expired then '${JOB_EXPIRED}'
                                 when p.exhausted then '${LEASE_LAPSED_FINAL_ATTEMPT}'
                                 else j.last_error end,
         last_error_stack = case when p.exhausted then null else j.last_error_stack end,
         updated_at       = now()
    from picked p
   where j.id = p.id
  returning ${CLAIM_ROW_COLUMNS}
), counted as (
  insert into x_job_counters (job, bucket_ms, bucket_start, dead, failed, duration_ms)
  select name, ${COUNTER_BUCKET_MS}, date_trunc('minute', now()),
         (count(*) filter (where state = 'dead'))::int,
         (count(*) filter (where state = 'failed'))::int, 0
    from taken
   where state <> 'running'
   group by name
  on conflict (job, bucket_ms, bucket_start) do update
     set dead   = x_job_counters.dead + excluded.dead,
         failed = x_job_counters.failed + excluded.failed
)
select ${CLAIM_ROW_NAMES}, st.steps${horizon ? ', null::bigint as due_in_ms' : ''}
  from taken t
  left join lateral (
    select json_agg(json_build_object(${STEP_FIELDS}) order by s.started_at) as steps
      from x_job_steps s
     where s.run_id = t.run_id and t.state = 'running'
  ) st on true${horizon ? HORIZON_ARM : ''}
`.trim();

export const SQL_CLAIM = claimSql(false);

/**
 * `SQL_CLAIM` plus, when it took nothing, ONE row of nulls carrying `due_in_ms` (`HORIZON`): what
 * an idle worker rests on. Its own statement because the arm is planned on every call whether it
 * runs or not — ~0.5 ms of planning a busy worker's claims would pay for nothing — so the driver
 * sends it only when the caller listens (`ClaimOptions.onEmpty`), which an idling loop does.
 */
export const SQL_CLAIM_IDLE = claimSql(true);

/** A claim answer row: a `JobRow` and its steps — or, idle and empty, nulls and the horizon. */
type ClaimRow = Omit<JobRow, 'id'> & {
  readonly id: string | null;
  readonly steps?: readonly StepRow[] | null;
  readonly due_in_ms?: number | string | null;
};

const taken = (row: ClaimRow): row is ClaimRow & JobRow => row.id !== null;

export async function pgClaim(
  exec: () => PgExecutor,
  clock: Clock | undefined,
  claimOptions: ClaimOptions,
): Promise<readonly ClaimedJob[]> {
  assertClaimQueues('pg', claimOptions);
  assertClaimBounds('pg', claimOptions);
  // The horizon arm is planned on every call: sent only to a caller listening for it.
  const rows = await exec().query<ClaimRow>(
    claimOptions.onEmpty === undefined ? SQL_CLAIM : SQL_CLAIM_IDLE,
    [
      claimOptions.queues,
      claimOptions.limit,
      claimOptions.workerId,
      claimOptions.visibilityTimeoutMs,
      claimOptions.dropExhausted ?? [],
    ],
  );
  const at = nowMs(clock);
  const answered = rows.filter(taken);
  if (answered.length === 0) {
    const due = rows[0]?.due_in_ms;
    claimOptions.onEmpty?.(due === null || due === undefined ? null : Number(due));
    return [];
  }
  // Both outcomes of the statement answer, told apart by the state each wrote: `running` is a
  // claim, `dead`/`failed` a row the claim buried — reported, never handed out as work.
  const buried: JobRecord[] = [];
  const claimed: ClaimedJob[] = [];
  for (const row of answered) {
    const record = toJobRecord(row);
    if (record.state !== 'running') {
      buried.push(record);
      continue;
    }
    claimed.push({
      ...record,
      claimedBy: claimOptions.workerId,
      claim: record.claim ?? 0,
      claimedAt: at,
      visibleAt: record.visibleAt ?? at + claimOptions.visibilityTimeoutMs,
      steps: (row.steps ?? []).map(toStepRecord),
    });
  }
  if (buried.length > 0) claimOptions.onExhausted?.(buried);
  return claimed;
}
