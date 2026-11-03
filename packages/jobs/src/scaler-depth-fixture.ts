// The queue depth a fleet autoscaler should size a set of queues by (KEDA's `postgresql` trigger, an
// HPA external metric): the jobs some live worker of THIS fleet must hold. Not the `queue_depth`
// gauge, which is ready-only and so scales a busy fleet down.
//
//   depth = running on a worker that still serves
//         + ready / delayed / suspended rows that are due (run_at <= now()) on an unpaused queue
//
// A `running` row whose claimer's registry row says `draining_at` is left out: that worker stopped
// claiming (a retire, a SIGTERM) and finishes the job itself, so no pod the scaler could add would
// ever take it. Counted, every deploy scaled the new ReplicaSet up for the old one's runs — for as
// long as the longest of them took. A claimer with no live registry row (killed, its row lapsed) is
// counted: the queue hands that job back, and somebody must pick it up.
//
// `$1` is the queues, as a text array. A scaler that cannot bind parameters (KEDA's `query`) inlines
// them as `'{a,b}'::text[]`. Served by `x_jobs_claim_idx` for the due rows and the registry's
// primary key for the claimers. The rows are `QUEUE_DEMAND_ROWS`, the ones the framework's own
// `queue_demand` gauge counts per queue, so a KEDA fleet and an HPA fleet size by one rule.

import { QUEUE_DEMAND_ROWS } from './driver-pg-demand-sql';

export const SQL_SCALER_DEMAND = `
select count(*)::int as depth
  from x_jobs j
 where j.queue = any($1::text[])
   and ${QUEUE_DEMAND_ROWS}
`.trim();
