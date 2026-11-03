// The claim's burial and the enqueue's retry against a real server, CONCURRENTLY — what the
// embedded database cannot show: it runs one statement at a time. Eight sessions claiming at once
// must bury each poison row exactly once (`for update skip locked` over both arms), and an enqueue
// racing its key's holder settling must answer, never refuse. The claim's PLAN lives here as well:
// a backlog is only ever cheap to claim from if it seeks. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { JobDriver, JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { postgresJobDriver } from './driver-pg';
import { SQL_CLAIM, SQL_JOBS_TABLE } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_claim_live');
const SESSIONS = 8;
const TTL_MS = 30_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** `count` rows a worker died holding: `running`, lease lapsed, `attempt` of `max` spent. */
const ORPHANS = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, claims,
   claimed_by, visible_at)
select gen_random_uuid(), $1, 'default', '{}'::jsonb, $1 || ':' || g, gen_random_uuid(),
       $2::int, $3::int, 'running', $2::int, 'worker-gone', now() - interval '1 second'
  from generate_series(1, $4::int) as g
`;

/** One row in exactly the shape a scenario names; everything unnamed is a due `ready` row. */
const ROW = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, claims,
   claimed_by, run_at, visible_at)
values ($1::uuid, $2, $3, '{}'::jsonb, $1::text, $1::uuid, $4::int, $5::int, $6, $4::int, $7,
        now() + ($8::bigint * interval '1 millisecond'),
        now() + ($9::bigint * interval '1 millisecond'))
`;

interface RowShape {
  readonly queue?: string;
  readonly name?: string;
  readonly state?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  /** Milliseconds from now; negative is due. */
  readonly runAtMs?: number;
  /** Milliseconds from now, for a `running` row's lease. */
  readonly visibleAtMs?: number;
}

/** Does any `LockRows` node in this explain tree have a `Sort` somewhere beneath it? */
const sortUnderLockRows = (node: unknown, underLock = false): boolean => {
  if (typeof node !== 'object' || node === null) return false;
  const type = 'Node Type' in node ? node['Node Type'] : undefined;
  // `Incremental Sort` too: a tiebreak the index cannot serve still sorts every row of one `run_at`.
  if (underLock && typeof type === 'string' && type.endsWith('Sort')) return true;
  const plans = 'Plans' in node && Array.isArray(node.Plans) ? node.Plans : [];
  return plans.some((child) => sortUnderLockRows(child, underLock || type === 'LockRows'));
};

describe.skipIf(!hasPostgres)('live · postgres · the claim buries a poison row once', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;
  let driver: JobDriver;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: SESSIONS } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    };
    driver = postgresJobDriver({ executor });
  });

  beforeEach(async () => {
    await executor.query('delete from x_jobs', []);
    await executor.query('delete from x_job_counters', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const pass = async (
    workerId: string,
    limit: number,
  ): Promise<{ readonly claimed: readonly string[]; readonly buried: readonly JobRecord[] }> => {
    const buried: JobRecord[] = [];
    const claimed = await driver.claim({
      queues: ['default'],
      limit,
      visibilityTimeoutMs: TTL_MS,
      workerId,
      onExhausted: (dead) => {
        buried.push(...dead);
      },
    });
    return { claimed: claimed.map((row) => row.id), buried };
  };

  const row = async (shape: RowShape = {}): Promise<string> => {
    const id = crypto.randomUUID();
    const state = shape.state ?? 'ready';
    await executor.query(ROW, [
      id,
      shape.name ?? 'probe',
      shape.queue ?? 'default',
      shape.attempt ?? 0,
      shape.maxAttempts ?? 3,
      state,
      state === 'running' ? 'worker-gone' : null,
      shape.runAtMs ?? -1_000,
      shape.visibleAtMs ?? null,
    ]);
    return id;
  };

  const claimOf = (queues: readonly string[], limit: number) =>
    driver.claim({ queues, limit, visibilityTimeoutMs: TTL_MS, workerId: 'w-scenario' });

  // THE SLICE'S WHOLE POINT. A sort under the lock reads every due row to hand out `limit` of them,
  // so a claim costs what the backlog costs, and a queue slows down exactly when it is behind.
  test('a claim seeks: a 20k backlog reads x_jobs_claim_idx and sorts nothing under the lock', async () => {
    await executor.query(
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
       select gen_random_uuid(), 'backlog', 'q' || (g % 3), '{}'::jsonb, g::text,
              gen_random_uuid(), 'ready', now() - (g * interval '1 second')
         from generate_series(1, 20000) as g`,
      [],
    );
    await executor.query('analyze x_jobs', []);
    const answer = await executor.query<{ 'QUERY PLAN': unknown }>(
      `explain (format json) ${SQL_CLAIM}`,
      [['q0', 'q1', 'q2'], 8, 'w-plan', TTL_MS, []],
    );
    const plan = answer.flatMap((line) => line['QUERY PLAN']);
    const text = JSON.stringify(plan);
    expect(text).toContain('x_jobs_claim_idx');
    // The lapsed arm's seek: dropped along with the stats read it first served, it scans.
    expect(text).toContain('x_jobs_depth_idx');
    expect(text).toContain('LockRows');
    const root = plan.map((entry) =>
      typeof entry === 'object' && entry !== null && 'Plan' in entry ? entry.Plan : entry,
    );
    expect(root.some((node) => sortUnderLockRows(node))).toBe(false);
  });

  test('the oldest due row of ANY queue goes first, whichever queue holds it', async () => {
    const third = await row({ queue: 'a', runAtMs: -1_000 });
    const first = await row({ queue: 'b', runAtMs: -3_000 });
    const second = await row({ queue: 'a', runAtMs: -2_000 });
    const claimed = await claimOf(['a', 'b'], 2);
    expect(new Set(claimed.map((job) => job.id))).toEqual(new Set([first, second]));
    const rest = await claimOf(['a', 'b'], 2);
    expect(rest.map((job) => job.id)).toEqual([third]);
  });

  test('due delayed and suspended rows are claimed; every other row is left alone', async () => {
    const delayed = await row({ state: 'delayed' });
    const suspended = await row({ state: 'suspended' });
    const ready = await row();
    const lapsed = await row({ state: 'running', attempt: 1, visibleAtMs: -1_000 });
    const untouched = [
      await row({ runAtMs: 60_000 }),
      await row({ state: 'delayed', runAtMs: 60_000 }),
      await row({ state: 'suspended', runAtMs: 60_000 }),
      await row({ state: 'running', attempt: 1, visibleAtMs: 60_000 }),
      await row({ state: 'running', attempt: 1, visibleAtMs: -1_000, runAtMs: 60_000 }),
      await row({ state: 'done' }),
      await row({ state: 'failed' }),
      await row({ state: 'dead' }),
      await row({ state: 'cancelled' }),
      await row({ queue: 'another' }),
    ];
    const claimed = await claimOf(['default'], 50);
    expect(new Set(claimed.map((job) => job.id))).toEqual(
      new Set([delayed, suspended, ready, lapsed]),
    );
    const stale = await executor.query<{ id: string }>(
      `select id from x_jobs where id = any($1::uuid[]) and claimed_by = 'w-scenario'`,
      [untouched],
    );
    expect(stale).toEqual([]);
  });

  test('a lapsed lease is retried on its next attempt, under the new claimer', async () => {
    const lapsed = await row({ state: 'running', attempt: 1, visibleAtMs: -1_000 });
    const [claimed] = await claimOf(['default'], 1);
    expect(claimed?.id).toBe(lapsed);
    expect(claimed?.attempt).toBe(2);
    expect(claimed?.claimedBy).toBe('w-scenario');
  });

  test('a paused queue is skipped and an open one beside it is not', async () => {
    await row({ queue: 'paused' });
    const open = await row({ queue: 'open' });
    await executor.query(`insert into x_job_pauses (kind, name) values ('queue', 'paused')`, []);
    try {
      const claimed = await claimOf(['paused', 'open'], 5);
      expect(claimed.map((job) => job.id)).toEqual([open]);
    } finally {
      await executor.query('delete from x_job_pauses', []);
    }
  });

  test('a poison row in one queue is buried and counted, a due row in another claimed', async () => {
    const poison = await row({
      queue: 'a',
      name: 'poison',
      state: 'running',
      attempt: 3,
      visibleAtMs: -1_000,
    });
    const due = await row({ queue: 'b' });
    const buried: JobRecord[] = [];
    const claimed = await driver.claim({
      queues: ['a', 'b'],
      limit: 5,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'w-scenario',
      onExhausted: (dead) => {
        buried.push(...dead);
      },
    });
    expect(claimed.map((job) => job.id)).toEqual([due]);
    expect(buried.map((job) => job.id)).toEqual([poison]);
    const counted = await executor.query<{ job: string; dead: number }>(
      'select job, sum(dead)::int as dead from x_job_counters group by job',
      [],
    );
    expect(counted).toEqual([{ job: 'poison', dead: 1 }]);
  });

  // One lateral per NAME: without the `distinct`, a repeated name locks its own rows twice — a row
  // already locked by this statement is not skipped — and the repeats spend `limit` on nothing.
  test('a queue named twice claims each row once and still fills the limit', async () => {
    const rows = [await row({ runAtMs: -2_000 }), await row({ runAtMs: -1_000 })];
    const claimed = await claimOf(['default', 'default'], 2);
    expect(claimed.map((job) => job.id).sort()).toEqual([...rows].sort());
  });

  // A limit that spans queues: the arms each take `limit` per queue, and only the outer one decides
  // what is handed out. Without it, three queues hand out three times what the worker has room for.
  test('the limit holds across every queue and both arms', async () => {
    for (const queue of ['a', 'b', 'c']) {
      await row({ queue });
      await row({ queue });
      await row({ queue, state: 'running', attempt: 1, visibleAtMs: -1_000 });
    }
    const claimed = await claimOf(['a', 'b', 'c'], 4);
    expect(claimed).toHaveLength(4);
    const [left] = await executor.query<{ n: number }>(
      `select count(*)::int as n from x_jobs where claimed_by = 'w-scenario'`,
      [],
    );
    expect(left?.n).toBe(4);
  });

  test('eight sessions over 240 rows across three queues: each once, 40 dead, none left', async () => {
    const queues = ['a', 'b', 'c'];
    await Promise.all(
      Array.from({ length: 240 }, (_, index) => {
        const queue = queues[index % 3] ?? 'a';
        if (index % 6 === 0) {
          return row({
            queue,
            name: 'poison',
            state: 'running',
            attempt: 3,
            visibleAtMs: -1_000,
          });
        }
        return row({ queue, runAtMs: -1_000 - index });
      }),
    );
    const buried: JobRecord[] = [];
    const claimed: string[] = [];
    for (let round = 0; round < 60; round += 1) {
      const answers = await Promise.all(
        Array.from({ length: SESSIONS }, (_, index) =>
          driver.claim({
            queues,
            limit: 7,
            visibilityTimeoutMs: TTL_MS,
            workerId: `w-${index}`,
            onExhausted: (dead) => {
              buried.push(...dead);
            },
          }),
        ),
      );
      claimed.push(...answers.flat().map((job) => job.id));
      if (answers.every((answer) => answer.length === 0) && claimed.length + buried.length === 240)
        break;
    }
    expect(buried).toHaveLength(40);
    expect(new Set(buried.map((job) => job.id)).size).toBe(40);
    expect(claimed).toHaveLength(200);
    expect(new Set(claimed).size).toBe(200);
    const [left] = await executor.query<{ n: number }>(
      `select count(*)::int as n from x_jobs where state in ('ready', 'delayed', 'suspended')`,
      [],
    );
    expect(left?.n).toBe(0);
  });

  test('eight workers claiming at once bury every exhausted row exactly once and claim the rest', async () => {
    await executor.query(ORPHANS, ['poison', 3, 3, 40]);
    await executor.query(ORPHANS, ['redeliver', 1, 3, 40]);

    const passes: { claimed: readonly string[]; buried: readonly JobRecord[] }[] = [];
    // Rounds until a whole round finds nothing: `skip locked` lets a pass come back short.
    for (let round = 0; round < 20; round += 1) {
      const results = await Promise.all(
        Array.from({ length: SESSIONS }, (_, index) => pass(`worker-${index}`, 7)),
      );
      passes.push(...results);
      if (results.every((result) => result.claimed.length + result.buried.length === 0)) break;
    }

    const buried = passes.flatMap((result) => result.buried);
    const claimed = passes.flatMap((result) => result.claimed);
    // Reported ONCE each: a row two passes both reported is an `onSettled` that fires twice.
    expect(buried).toHaveLength(40);
    expect(new Set(buried.map((row) => row.id)).size).toBe(40);
    expect(buried.every((row) => row.name === 'poison' && row.state === 'dead')).toBe(true);
    expect(buried.every((row) => row.lastError === LEASE_LAPSED_FINAL_ATTEMPT)).toBe(true);
    expect(claimed).toHaveLength(40);
    expect(new Set(claimed).size).toBe(40);

    const states = await executor.query<{
      name: string;
      state: string;
      attempt: number;
      n: number;
    }>(
      `select name, state, attempt, count(*)::int as n from x_jobs
        group by name, state, attempt order by name`,
      [],
    );
    expect(states).toEqual([
      { name: 'poison', state: 'dead', attempt: 3, n: 40 },
      { name: 'redeliver', state: 'running', attempt: 2, n: 40 },
    ]);
    // Counted once each too, however the forty were split between passes and upserts.
    const counted = await executor.query<{ job: string; dead: number }>(
      'select job, sum(dead)::int as dead from x_job_counters group by job',
      [],
    );
    expect(counted).toEqual([{ job: 'poison', dead: 40 }]);
    expect((await driver.introspect?.deadLetters(100))?.length).toBe(40);
  });

  test('an enqueue racing its key holder settling answers every time — deduped or a new row', async () => {
    const outcomes = { deduped: 0, inserted: 0 };
    for (let round = 0; round < 60; round += 1) {
      const request = {
        name: 'racer',
        queue: 'default',
        input: {},
        idempotencyKey: `racer:${round}`,
        maxAttempts: 3,
      };
      const holder = await driver.enqueue(request);
      const [claimed] = await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: TTL_MS,
        workerId: 'holder',
      });
      expect(claimed?.id).toBe(holder.id);
      // The holder acks while four callers enqueue its key. Whichever side of the ack each insert
      // and each lookup lands on, the answer is an id — never `X_DRIVER_UNAVAILABLE`.
      const [acked, answers] = await Promise.all([
        driver.ack(holder.id, { workerId: 'holder', claim: claimed?.claim ?? 0 }),
        Promise.all(Array.from({ length: 4 }, () => driver.enqueue(request))),
      ]);
      expect(acked).toBe(true);
      for (const answer of answers) {
        if (answer.deduped) outcomes.deduped += 1;
        else outcomes.inserted += 1;
      }
      // At most one live row of the key, whatever the interleaving.
      const live = await executor.query<{ n: number }>(
        `select count(*)::int as n from x_jobs
          where idempotency_key = $1 and state in ('ready', 'delayed', 'running', 'suspended')`,
        [request.idempotencyKey],
      );
      expect(live[0]?.n).toBeLessThanOrEqual(1);
      await executor.query(`update x_jobs set state = 'done' where idempotency_key = $1`, [
        request.idempotencyKey,
      ]);
    }
    expect(outcomes.deduped + outcomes.inserted).toBe(240);
  });
});
