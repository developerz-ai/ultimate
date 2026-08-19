import { describe, expect, test } from 'bun:test';
import { DEFAULT_QUEUE } from './driver';
import type { PgExecutor } from './driver-pg';
import { createPgDriver, createPgLeader } from './driver-pg';
import {
  SQL_ACK,
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_PROGRESS,
  SQL_BACKFILL_START,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_FIND_LIVE_BY_KEY,
  SQL_HEARTBEAT,
  SQL_JOBS_TABLE,
  SQL_NACK,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { DriverUnavailableError, JobDuplicateError } from './errors';

function recordingExecutor(rows: readonly unknown[] = []): PgExecutor & {
  readonly calls: { sql: string; params: readonly unknown[] }[];
} {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve(rows as readonly R[]);
    },
  };
}

describe('pg queue SQL', () => {
  test('the claim uses FOR UPDATE SKIP LOCKED — without it N workers serialise', () => {
    expect(SQL_CLAIM).toContain('for update skip locked');
    expect(SQL_CLAIM).toContain("set state      = 'running'");
    // Lease reclaim: a crashed worker's job becomes claimable again.
    expect(SQL_CLAIM).toContain("state = 'running' and visible_at <= now()");
    expect(SQL_CLAIM).toContain('attempt    = j.attempt + 1');
  });

  test('idempotency is enforced per JOB and per TENANT by a partial unique index over live states only', () => {
    // `(name, coalesce(tenant_id, ''), idempotency_key)`. A global key namespace was silent data
    // loss — two jobs deriving the same natural key deduped against each other and the second one
    // never ran — and a tenant-blind one was that plus a cross-tenant job id handed to the caller.
    expect(SQL_JOBS_TABLE).toContain(
      'create unique index if not exists x_jobs_name_tenant_idempotency_live_idx',
    );
    expect(SQL_JOBS_TABLE).toContain(
      "on x_jobs (name, (coalesce(tenant_id, '')), idempotency_key)",
    );
    expect(SQL_JOBS_TABLE).toContain("where state in ('ready', 'delayed', 'running', 'suspended')");
    // The conflict target must spell the index expression exactly, or Postgres cannot infer it.
    expect(SQL_ENQUEUE).toContain("on conflict (name, (coalesce(tenant_id, '')), idempotency_key)");
    expect(SQL_ENQUEUE).toContain('do nothing');
  });

  test('nack only burns an attempt when the failure counts as one', () => {
    expect(SQL_NACK).toContain(
      'case when $3::boolean then attempt else greatest(attempt - 1, 0) end',
    );
  });

  test('ack and heartbeat target a single row by id', () => {
    expect(SQL_ACK).toContain('where id = $1');
    expect(SQL_HEARTBEAT).toContain("where id = $1 and state = 'running'");
  });

  test('the scheduler leader uses a session advisory lock', () => {
    expect(SQL_TRY_ADVISORY_LOCK).toContain('pg_try_advisory_lock');
  });
});

describe('pg driver', () => {
  test('claim passes the queue list, limit, worker id and visibility timeout in order', async () => {
    const executor = recordingExecutor();
    const driver = createPgDriver({ executor });
    await driver.claim({
      queues: ['default', 'mail'],
      limit: 7,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-a',
    });
    expect(executor.calls[0]?.sql).toBe(SQL_CLAIM);
    expect(executor.calls[0]?.params).toEqual([['default', 'mail'], 7, 'worker-a', 30_000]);
  });

  test('a deduped enqueue reports the existing live row instead of inserting', async () => {
    let call = 0;
    const executor: PgExecutor = {
      query<R>(): Promise<readonly R[]> {
        call += 1;
        // First call: the INSERT ... DO NOTHING returns no row. Second: the live-row lookup.
        const rows = call === 1 ? [] : [{ id: 'job-1', run_id: 'run-1' }];
        return Promise.resolve(rows as unknown as readonly R[]);
      },
    };
    const result = await createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: 'default',
      input: { orgId: 'org-1' },
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
    });
    expect(result).toEqual({ id: 'job-1', runId: 'run-1', deduped: true });
  });

  test('no executor and no DATABASE_URL is a labelled X_DRIVER_UNAVAILABLE', async () => {
    await expect(createPgDriver().stats()).rejects.toThrow(DriverUnavailableError);
  });
});

describe('the pg backfill ledger', () => {
  const ledgerOf = (executor: PgExecutor) => {
    const ledger = createPgDriver({ executor }).backfills;
    if (ledger === undefined) throw new Error('the pg driver must ship a backfill ledger');
    return ledger;
  };

  test('every write binds its parameters in the order the statement declares them', async () => {
    const executor = recordingExecutor();
    const ledger = ledgerOf(executor);

    await ledger.start({
      runId: 'run-1',
      name: 'sweep',
      checksum: 'aaaa',
      appVersion: '1.2.0',
    });
    await ledger.progress('run-1', { rows: 6, cursor: 'c6' });
    await ledger.finish('run-1', { status: 'completed', rows: 10 });

    expect(executor.calls.map((call) => call.params)).toEqual([
      ['run-1', 'sweep', 'aaaa', '1.2.0'],
      ['run-1', 6, 'c6'],
      ['run-1', 'completed', 10],
    ]);
    expect(executor.calls.map((call) => call.sql)).toEqual([
      SQL_BACKFILL_START,
      SQL_BACKFILL_PROGRESS,
      SQL_BACKFILL_FINISH,
    ]);
  });

  test('a row comes back as epoch milliseconds, a number of rows and a nullable cursor', async () => {
    // `rows_processed` is a bigint, which a Postgres client hands back as a string, and the two
    // timestamps arrive already extracted by the statement.
    const executor = recordingExecutor([
      {
        run_id: 'run-1',
        name: 'sweep',
        checksum: 'aaaa',
        status: 'completed',
        app_version: '1.2.0',
        rows_processed: '4200',
        last_cursor: null,
        started_at: '1000',
        completed_at: '2000',
      },
    ]);

    const runs = await ledgerOf(executor).list({ name: 'sweep', status: 'completed', limit: 5 });

    expect(runs).toEqual([
      {
        runId: 'run-1',
        name: 'sweep',
        checksum: 'aaaa',
        status: 'completed',
        appVersion: '1.2.0',
        rows: 4200,
        cursor: null,
        startedAt: 1000,
        completedAt: 2000,
      },
    ]);
    expect(executor.calls[0]?.params).toEqual(['sweep', 'completed', null, 5]);
  });

  test('an unfiltered list is nulls and the default limit, never a missing predicate', async () => {
    const executor = recordingExecutor();
    await ledgerOf(executor).list();
    expect(executor.calls[0]?.params).toEqual([null, null, null, 100]);
  });

  test('a run id rides in its own parameter, cast to the uuid the column actually is', async () => {
    const executor = recordingExecutor();
    await ledgerOf(executor).list({ runId: '11111111-2222-3333-4444-555555555555', limit: 1 });

    expect(executor.calls[0]?.params).toEqual([
      null,
      null,
      '11111111-2222-3333-4444-555555555555',
      1,
    ]);
    // `run_id` IS a uuid, and `uuid = text` has no operator in Postgres — so `::uuid` here is not
    // a style choice next to its two `::text` neighbours: `::text` fails every call, filtered or
    // not. Pinned as text so a reformat of the SQL does not silently retire the assertion.
    expect(SQL_BACKFILL_LIST).toContain('$3::uuid is null or run_id = $3');
  });
});

describe('pg enqueue, ack and nack', () => {
  test('an insert that lands reports the new id and deduped: false', async () => {
    const executor = recordingExecutor([{ id: 'job-1', run_id: 'run-1' }]);
    const result = await createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: '',
      input: { orgId: 'org-1' },
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
      tenantId: 'org-1',
      traceparent: '00-abc-def-01',
      enqueuedBy: 'user-7',
    });
    expect(result).toEqual({ id: 'job-1', runId: 'run-1', deduped: false });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.sql).toBe(SQL_ENQUEUE);
    // An empty queue falls back to the default rather than inserting '' — a queue no worker polls.
    expect(executor.calls[0]?.params[2]).toBe(DEFAULT_QUEUE);
    expect(executor.calls[0]?.params.slice(3, 5)).toEqual([
      JSON.stringify({ orgId: 'org-1' }),
      'onboard:org-1',
    ]);
    expect(executor.calls[0]?.params.slice(8)).toEqual(['org-1', '00-abc-def-01', 'user-7']);
  });

  test('the live-row lookup is keyed by name, key AND tenant — never by the key alone', async () => {
    // Without the name it returned whichever other job derived the same natural key; without the
    // tenant it handed the caller another tenant's job id, on a surface that cancels by id.
    let call = 0;
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        calls.push({ sql, params });
        call += 1;
        return Promise.resolve(
          (call === 1 ? [] : [{ id: 'job-9', run_id: 'run-9' }]) as readonly R[],
        );
      },
    };
    await createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: 'default',
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
      tenantId: 'org-1',
    });
    expect(calls[1]?.sql).toBe(SQL_FIND_LIVE_BY_KEY);
    expect(calls[1]?.params).toEqual(['onboardOrg', 'onboard:org-1', 'org-1']);
  });

  test('onConflict: error is X_JOB_DUPLICATE naming the row that holds the key', async () => {
    let call = 0;
    const executor: PgExecutor = {
      query<R>(): Promise<readonly R[]> {
        call += 1;
        return Promise.resolve(
          (call === 1 ? [] : [{ id: 'job-9', run_id: 'run-9' }]) as readonly R[],
        );
      },
    };
    const enqueue = createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: 'default',
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
      onConflict: 'error',
    });
    await expect(enqueue).rejects.toThrow(JobDuplicateError);
    await expect(enqueue).rejects.toThrow(/job-9/);
  });

  test('a refused insert with NO live row is X_DRIVER_UNAVAILABLE pointing at the index', async () => {
    // The only way both statements answer nothing is a missing partial unique index, so the fix
    // has to be the migration — not "retry", which would refuse forever.
    const executor = recordingExecutor([]);
    const enqueue = createPgDriver({ executor }).enqueue({
      name: 'onboardOrg',
      queue: 'default',
      idempotencyKey: 'onboard:org-1',
      maxAttempts: 5,
    });
    await expect(enqueue).rejects.toThrow(DriverUnavailableError);
    await expect(enqueue).rejects.toThrow(/no live row holds its idempotency key/);
  });

  test('a claimed row carries the claim time and a visibility deadline derived from it', async () => {
    const clock = { now: () => new Date(50_000), monotonic: () => 50_000 };
    const executor = recordingExecutor([
      {
        id: 'job-1',
        name: 'sendInvite',
        queue: 'mail',
        input: null,
        idempotency_key: 'invite:1',
        run_id: 'run-1',
        attempt: 1,
        max_attempts: 5,
        state: 'running',
        tenant_id: null,
        last_error: null,
        claimed_by: 'worker-a',
        run_at: '1000',
        visible_at: null,
        created_at: '900',
        updated_at: '1000',
      },
    ]);
    const [claimed] = await createPgDriver({ executor, clock }).claim({
      queues: [],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-a',
    });
    expect(claimed?.claimedAt).toBe(50_000);
    // The row's own visible_at was null, so the deadline is claim time plus the timeout — a
    // worker that read 0 here would have its lease expire the instant it started.
    expect(claimed?.visibleAt).toBe(80_000);
    // An empty queue list claims the default queue rather than nothing at all.
    expect(executor.calls[0]?.params[0]).toEqual([DEFAULT_QUEUE]);
  });

  test('ack settles one id', async () => {
    const executor = recordingExecutor();
    await createPgDriver({ executor }).ack('job-1');
    expect(executor.calls[0]?.sql).toBe(SQL_ACK);
    expect(executor.calls[0]?.params).toEqual(['job-1']);
  });

  test('nack maps deadLetter, park and neither onto three states, and park burns no attempt', async () => {
    const executor = recordingExecutor();
    const driver = createPgDriver({ executor });
    await driver.nack('job-1', { delayMs: 1_000, error: 'smtp timeout' });
    await driver.nack('job-2', { delayMs: 0, park: true, countsAsAttempt: false });
    await driver.nack('job-3', { delayMs: 0, deadLetter: true, park: true });

    expect(executor.calls.map((call) => call.params)).toEqual([
      ['job-1', 'ready', true, 1_000, 'smtp timeout'],
      ['job-2', 'suspended', false, 0, null],
      // deadLetter wins over park: a job that exhausted its retries is not merely shed.
      ['job-3', 'dead', true, 0, null],
    ]);
    expect(executor.calls[0]?.sql).toBe(SQL_NACK);
  });

  test('heartbeat is false when no row comes back — the lease is no longer this worker`s', async () => {
    const lost = recordingExecutor([]);
    expect(
      await createPgDriver({ executor: lost }).heartbeat('job-1', {
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-a',
      }),
    ).toBe(false);
    expect(lost.calls[0]?.sql).toBe(SQL_HEARTBEAT);
    expect(lost.calls[0]?.params).toEqual(['job-1', 30_000, 'worker-a']);

    const kept = recordingExecutor([{ id: 'job-1' }]);
    expect(
      await createPgDriver({ executor: kept }).heartbeat('job-1', { visibilityTimeoutMs: 30_000 }),
    ).toBe(true);
    expect(kept.calls[0]?.params).toEqual(['job-1', 30_000, null]);
  });
});

describe('the advisory-lock leader', () => {
  test('a lock it never won is never unlocked — releasing one costs another holder its grant', async () => {
    const executor = recordingExecutor([{ locked: false }]);
    const leader = createPgLeader(42, { executor });
    expect(await leader.acquire()).toBe(false);
    await leader.release();
    expect(executor.calls.map((call) => call.sql)).toEqual([SQL_TRY_ADVISORY_LOCK]);
    expect(executor.calls[0]?.params).toEqual([42]);
  });

  test('with no executor it refuses with X_DRIVER_UNAVAILABLE rather than reading as leader', async () => {
    await expect(createPgLeader(42).acquire()).rejects.toThrow(DriverUnavailableError);
  });
});
