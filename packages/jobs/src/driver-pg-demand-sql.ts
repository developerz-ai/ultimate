// `queue_demand` on Postgres: which `x_jobs` rows a serving worker of the fleet must hold, and that
// count per queue. One predicate, because `SQL_SCALER_DEMAND` (a scaler reading Postgres itself) and
// the gauge answer one question. Only Postgres knows who drains, so no sum of gauges can replace it.

/**
 * A `running` row whose claimer's live registry row says `draining_at` is out: that worker claims
 * nothing more and finishes the job itself, so no pod a scaler adds could take it. One adopter
 * counted them and averaged 1.84 pods where one carried the load. A claimer with no live row
 * (killed, lapsed) stays in: the queue hands that job back and somebody must pick it up.
 */
export const QUEUE_DEMAND_ROWS = `((j.state = 'running'
         and not exists (select 1 from x_job_workers w
                          where w.id = j.claimed_by
                            and w.draining_at is not null
                            and w.expires_at > now()))
     or (j.state in ('ready', 'delayed', 'suspended') and j.run_at <= now()
         and not exists (select 1 from x_job_pauses p
                          where p.kind = 'queue' and p.name = j.queue)))`;

/** Grouped, every 15 s from a worker with work about: an idle one never asks (`worker-queue-demand.ts`). */
export const SQL_QUEUE_DEMAND = `
select j.queue, count(*)::int as demand
  from x_jobs j
 where ${QUEUE_DEMAND_ROWS}
 group by j.queue
 order by j.queue collate "C"
`.trim();
