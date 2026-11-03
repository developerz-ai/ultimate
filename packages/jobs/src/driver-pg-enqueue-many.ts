// The Postgres driver's `enqueueMany`: every request in ONE insert over `jsonb_array_elements`,
// with `SQL_ENQUEUE`'s conflict target and its `not exists` on the id, then one read for the rows
// that insert did not return. Split from `driver-pg.ts` at that file's size ceiling.

import type { Clock, PgExecutor } from '@ultimat3/core';
import { uuidV7 } from '@ultimat3/core';
import { nowMs } from './clock';
import type { EnqueueRequest, EnqueueResult } from './driver';
import { assertEnqueueMany, DEFAULT_QUEUE } from './driver';
import { notifyJobReady } from './driver-pg-wake-sql';

/**
 * Each request is one element of `$1`, in request order. The insert is `SQL_ENQUEUE`'s, row for
 * row: the same conflict target spelling the index expression, and the same `not exists` on the
 * id — without it a relayed batch repeated after a crash runs every job that already FINISHED a
 * second time, because the partial index collapses a repeat only while its job is live.
 *
 * Two requests sharing a key inside the batch: `order by ord` inserts the first, and `do nothing`
 * skips the second against the row the same statement just wrote.
 *
 * `runAt` crosses as `numeric` and is rounded by its `::bigint`, the instant `SQL_ENQUEUE`'s
 * `$8::numeric::bigint` stores: JSON text such as `1767225660000.5` is no `bigint` literal, so a fractional
 * epoch ms — `now + Math.random() * 1000` — was a raw `22P02` here and fine one row at a time.
 *
 * ONE wake per queue: only the earliest-due row of each queue asks `notifyJobReady`. A batch of
 * 1,000 rows is one queue becoming claimable, not 1,000 announcements of it.
 */
export const SQL_ENQUEUE_MANY = `
with req as (
  select (r->>'id')::uuid as id, r->>'name' as name, r->>'queue' as queue, r->'input' as input,
         r->>'idempotencyKey' as idempotency_key, (r->>'runId')::uuid as run_id,
         (r->>'maxAttempts')::int as max_attempts,
         to_timestamp((r->>'runAt')::numeric::bigint / 1000.0) as run_at,
         r->>'tenantId' as tenant_id, r->>'traceparent' as traceparent,
         r->>'enqueuedBy' as enqueued_by, t.ord
    from jsonb_array_elements($1::jsonb) with ordinality as t(r, ord)
), inserted as (
  insert into x_jobs
    (id, name, queue, input, idempotency_key, run_id, max_attempts, state, run_at, tenant_id,
     traceparent, enqueued_by)
  select q.id, q.name, q.queue, q.input, q.idempotency_key, q.run_id, q.max_attempts,
         case when q.run_at > now() then 'delayed' else 'ready' end,
         q.run_at, q.tenant_id, q.traceparent, q.enqueued_by
    from req q
   where not exists (select 1 from x_jobs published where published.id = q.id)
   order by q.ord
  on conflict (name, (coalesce(tenant_id, '')), idempotency_key)
    where state in ('ready', 'delayed', 'running', 'suspended')
    do nothing
  returning id, run_id, queue, run_at
)
select r.id, r.run_id,
       case when r.first then${notifyJobReady('r')}::text end as woke
  from (select i.id, i.run_id, i.queue, i.run_at,
               row_number() over (partition by i.queue order by i.run_at, i.id) = 1 as first
          from inserted i) r
`.trim();

/**
 * Who answers a request the insert skipped, one row per request: the job under its own id — a
 * publish repeated, `pick` 0 — or the LIVE holder of its key in its name and tenant, `pick` 1,
 * which `SQL_FIND_LIVE_BY_KEY` reads one at a time. A request neither finds is a holder that
 * settled between the two statements, and goes back through `enqueue`, which retries it.
 */
export const SQL_ENQUEUE_MANY_RESOLVE = `
select (t.r->>'ord')::int as ord, x.id, x.run_id
  from jsonb_array_elements($1::jsonb) as t(r)
  cross join lateral (
    select c.id, c.run_id, c.pick from (
      select j.id, j.run_id, 0 as pick from x_jobs j where j.id = (t.r->>'id')::uuid
      union all
      select j.id, j.run_id, 1 as pick from x_jobs j
       where j.name = t.r->>'name'
         and j.idempotency_key = t.r->>'idempotencyKey'
         and coalesce(j.tenant_id, '') = coalesce(t.r->>'tenantId', '')
         and j.state in ('ready', 'delayed', 'running', 'suspended')
    ) c
    order by c.pick
    limit 1
  ) x
`.trim();

interface Inserted {
  readonly id: string;
  readonly run_id: string;
}

interface Resolved extends Inserted {
  readonly ord: number | string;
}

/** A request with its ids settled: the batch is read back by id, so every row needs one. */
type Stated = EnqueueRequest & { readonly id: string; readonly runId: string };

const wire = (request: Stated, at: number) => ({
  id: request.id,
  runId: request.runId,
  name: request.name,
  queue: request.queue || DEFAULT_QUEUE,
  input: request.input ?? null,
  idempotencyKey: request.idempotencyKey,
  maxAttempts: request.maxAttempts,
  runAt: request.runAt ?? at,
  tenantId: request.tenantId,
  traceparent: request.traceparent,
  enqueuedBy: request.enqueuedBy,
});

/**
 * `enqueueMany` over `exec`. `enqueueOne` is the driver's own `enqueue`, for the one request
 * whose answer moved between the two statements. Answers in request order.
 */
export async function pgEnqueueMany(
  exec: () => PgExecutor,
  clock: Clock,
  requests: readonly EnqueueRequest[],
  enqueueOne: (request: EnqueueRequest) => Promise<EnqueueResult>,
): Promise<readonly EnqueueResult[]> {
  assertEnqueueMany('pg', requests);
  if (requests.length === 0) return [];
  const at = nowMs(clock);
  const stated: Stated[] = requests.map((request) => ({
    ...request,
    id: request.id ?? uuidV7(),
    runId: request.runId ?? uuidV7(),
  }));
  const rows = await exec().query<Inserted>(SQL_ENQUEUE_MANY, [
    JSON.stringify(stated.map((request) => wire(request, at))),
  ]);
  const inserted = new Map(rows.map((row) => [row.id, row.run_id]));
  const results: (EnqueueResult | undefined)[] = stated.map((request) => {
    const runId = inserted.get(request.id);
    return runId === undefined ? undefined : { id: request.id, runId, deduped: false };
  });
  const skipped = stated.flatMap((request, ord) =>
    results[ord] === undefined ? [{ ...wire(request, at), ord }] : [],
  );
  if (skipped.length === 0) return results.filter((result) => result !== undefined);

  const found = await exec().query<Resolved>(SQL_ENQUEUE_MANY_RESOLVE, [JSON.stringify(skipped)]);
  for (const row of found) {
    const ord = Number(row.ord);
    if (stated[ord] === undefined) continue;
    results[ord] = { id: row.id, runId: row.run_id, deduped: true };
  }
  const answered: EnqueueResult[] = [];
  for (const [ord, result] of results.entries()) {
    const request = stated[ord];
    if (result !== undefined) answered.push(result);
    else if (request !== undefined) answered.push(await enqueueOne(request));
  }
  return answered;
}
