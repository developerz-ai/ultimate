// The queue `statement-plans.live.test.ts` plans every framework statement against: tens of
// thousands of `x_jobs` rows across states, queues and tenants, in the proportions a production
// queue holds them (a fortnight of `done`, a backlog, a handful running), plus the tables beside it.
// The named rows are the ones a statement addresses by id; every other row is bulk.

/** The rows a statement names. Fixed, so a case reads as the call the driver makes. */
export const SEEDED = {
  running: '00000000-0000-4000-8000-000000000001',
  runningRun: '00000000-0000-4000-8000-000000000101',
  dead: '00000000-0000-4000-8000-000000000002',
  deadRun: '00000000-0000-4000-8000-000000000102',
  done: '00000000-0000-4000-8000-000000000003',
  doneRun: '00000000-0000-4000-8000-000000000103',
  delayed: '00000000-0000-4000-8000-000000000004',
  suspendedRun: '00000000-0000-4000-8000-000000000105',
  outboxClaimed: '00000000-0000-4000-8000-000000000006',
  worker: 'worker-a',
  relay: 'relay-a',
  event: 'order.paid',
} as const;

/** The table sizes the seed writes, asserted after it so a shrunk seed cannot pass vacuously. */
export const SEEDED_FLOOR = { x_jobs: 60_000, x_outbox: 20_000 } as const;

const QUEUES = `(array['default', 'mail', 'reports'])[1 + g % 3]`;
const NAMES = `(array['mail.send', 'report.build', 'invoice.sync', 'webhook.deliver'])[1 + g % 4]`;
const TENANT = `case when g % 7 = 0 then null else 'org-' || (g % 20) end`;

/** Row `g` of `count`, spread evenly over the last `ageSeconds`: the oldest is that old. */
const spread = (count: number, ageSeconds: number): string =>
  `now() - (g::bigint * ${ageSeconds} / ${count}) * interval '1 second'`;

/**
 * Bulk rows of one state: `count` of them, created and last moved over the last `ageSeconds`.
 * `runAt` is an expression over `g`; `AGE` in it stands for the row's own instant.
 */
const bulk = (state: string, count: number, ageSeconds: number, runAt: string): string => `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, run_at,
   tenant_id, created_at, updated_at, last_error, claimed_by, visible_at, claims)
select gen_random_uuid(), ${NAMES}, ${QUEUES}, '{"n":1}'::jsonb, '${state}:' || g,
       gen_random_uuid(), 1, 3, '${state}', ${runAt.replace('AGE', spread(count, ageSeconds))},
       ${TENANT}, ${spread(count, ageSeconds)}, ${spread(count, ageSeconds)},
       case when '${state}' in ('dead', 'failed') then 'boom' end,
       case when '${state}' = 'running' then 'worker-' || (g % 6) end,
       case when '${state}' = 'running' then now() + interval '30 seconds' end,
       case when '${state}' = 'running' then 1 else 0 end
  from generate_series(1, ${count}) g`;

const FORTNIGHT = 14 * 24 * 3600;

/** Every statement of the seed, in order. Ends with `analyze`: a plan is only as good as its stats. */
export const SEED_STATEMENTS: readonly string[] = [
  bulk('done', 56_000, FORTNIGHT, 'AGE'),
  bulk('dead', 1_200, FORTNIGHT, "now() - interval '1 day'"),
  bulk('failed', 600, FORTNIGHT, "now() - interval '1 day'"),
  bulk('cancelled', 400, FORTNIGHT, "now() - interval '1 day'"),
  bulk('ready', 1_500, 3_600, `now() - (g % 600) * interval '1 second'`),
  bulk('delayed', 400, 3_600, `now() + (1 + g % 3600) * interval '1 second'`),
  bulk('running', 60, 600, `now() - interval '1 minute'`),
  bulk('suspended', 40, 3_600, `now() + interval '1 hour'`),
  // A queue holding only future rows: what an idle claim's horizon reads.
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
   select gen_random_uuid(), 'digest.send', 'digest', '{}'::jsonb, 'digest:' || g,
          gen_random_uuid(), 'delayed', now() + g * interval '1 minute'
     from generate_series(1, 50) g`,
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, attempt, state, run_at,
                       claimed_by, claims, visible_at, tenant_id)
   values ('${SEEDED.running}', 'mail.send', 'mail', '{}', 'named:running', '${SEEDED.runningRun}',
           1, 'running', now() - interval '1 minute', '${SEEDED.worker}', 1,
           now() + interval '30 seconds', 'org-3')`,
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, attempt, state, run_at,
                       last_error, tenant_id, updated_at)
   values ('${SEEDED.dead}', 'mail.send', 'mail', '{}', 'named:dead', '${SEEDED.deadRun}', 3,
           'dead', now() - interval '1 day', 'boom', 'org-3', now() - interval '1 day')`,
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, attempt, claims, state,
                       run_at, settle_owed, updated_at)
   values ('${SEEDED.done}', 'mail.send', 'mail', '{}', 'named:done', '${SEEDED.doneRun}', 1, 1,
           'done', now() - interval '1 hour', true, now() - interval '1 hour')`,
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
   values ('${SEEDED.delayed}', 'report.build', 'reports', '{}', 'named:delayed',
           gen_random_uuid(), 'delayed', now() + interval '1 hour')`,
  `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
   values (gen_random_uuid(), 'invoice.sync', 'default', '{}', 'named:suspended',
           '${SEEDED.suspendedRun}', 'suspended', now() + interval '1 hour')`,
  // Steps: two per run for a third of the finished runs, and the named runs' own.
  `insert into x_job_steps (run_id, name, status, output, started_at, completed_at)
   select j.run_id, s.name, 'completed', '{}'::jsonb, j.created_at, j.updated_at
     from (select run_id, created_at, updated_at from x_jobs where state = 'done' limit 20000) j
    cross join (values ('fetch'), ('send')) s(name)`,
  `insert into x_job_steps (run_id, name, status, started_at)
   values ('${SEEDED.runningRun}', 'fetch', 'completed', now() - interval '1 minute'),
          ('${SEEDED.deadRun}', 'charge', 'failed', now() - interval '1 day')`,
  `insert into x_job_steps (run_id, name, status, started_at, event, correlation_key, wake_at)
   values ('${SEEDED.suspendedRun}', 'await-pay', 'waiting', now(), '${SEEDED.event}', 'k1',
           now() + interval '1 hour')`,
  // The outbox: a published history, a few waiting, one held by a relay.
  `insert into x_outbox (id, job, queue, input, idempotency_key, staged_at, published_at, run_id)
   select gen_random_uuid(), 'mail.send', 'mail', '{}'::jsonb, 'o:' || g,
          now() - (g % 86400) * interval '1 second', now() - (g % 86400) * interval '1 second',
          gen_random_uuid()
     from generate_series(1, 25000) g`,
  `insert into x_outbox (id, job, queue, input, idempotency_key, staged_at, run_id)
   select gen_random_uuid(), 'mail.send', 'mail', '{}'::jsonb, 'w:' || g,
          now() - g * interval '1 second', gen_random_uuid()
     from generate_series(1, 40) g`,
  `insert into x_outbox (id, job, queue, input, idempotency_key, run_id, claimed_at, claimed_by)
   values ('${SEEDED.outboxClaimed}', 'mail.send', 'mail', '{}', 'held', gen_random_uuid(), now(),
           '${SEEDED.relay}')`,
  `insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
   select gen_random_uuid(), 'event.' || (g % 10), '{}'::jsonb, 'k' || g,
          now() - (g % 3600) * interval '1 second', now() + interval '1 day'
     from generate_series(1, 5000) g`,
  `insert into x_job_counters (job, bucket_ms, bucket_start, done)
   select n, 60000, date_trunc('minute', now()) - g * interval '1 minute', 1
     from generate_series(0, 1439) g
    cross join (values ('mail.send'), ('report.build')) j(n)`,
  `insert into x_job_workers (id, host, queues, concurrency, in_flight, started_at, expires_at)
   select 'worker-' || g, 'host-' || g, '["default","mail"]', 8, '[]', now(),
          now() + interval '1 minute'
     from generate_series(0, 5) g`,
  `insert into x_job_workers (id, host, queues, concurrency, in_flight, started_at, expires_at)
   values ('${SEEDED.worker}', 'host-a', '["mail"]', 8, '[]', now(), now() + interval '1 minute')`,
  `insert into x_scheduler_state (task_name, last_fired_at, fired_occurrence_at, fired_at)
   select 'task-' || g, now() - interval '1 minute', now() - interval '1 minute', now()
     from generate_series(1, 43) g`,
  `insert into x_backfills (run_id, name, checksum, app_version, status)
   select gen_random_uuid(), 'backfill-' || g, 'c', 'v1', 'completed'
     from generate_series(1, 10) g`,
  'analyze',
];
