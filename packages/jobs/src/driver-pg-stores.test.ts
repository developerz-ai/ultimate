// The pg driver's three stores and its introspection, over an injected executor. What is under
// test is the part a live Postgres could not tell you anyway: which statement is issued, in which
// order, with which parameters — and what comes back out of a row. The executor here answers rows
// and records calls; it evaluates no SQL, and it THROWS on a statement the test did not arrange,
// so a driver that starts issuing a different one fails here rather than reading as covered.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import type { JobRow } from './driver-pg-rows';
import {
  SQL_CANCEL,
  SQL_LEASE_ACQUIRE,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_LIST,
  SQL_STEP_PUT,
} from './driver-pg-sql';
import { DriverUnavailableError } from './errors';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Rows are keyed by a fragment of the statement that asks for them. An unmatched statement is a
 * throw, never an empty result: "no rows" is a meaningful answer everywhere in this driver, so a
 * fake that defaulted to it would let a renamed statement pass as a legitimate miss.
 */
function executorFor(answers: Readonly<Record<string, readonly unknown[]>> = {}): PgExecutor & {
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const entries = Object.entries(answers);
  return {
    calls,
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      const match = entries.find(([fragment]) => sql.includes(fragment));
      if (match === undefined && entries.length > 0) {
        throw new Error(`this fake cannot answer: ${sql.trim().slice(0, 80)}`);
      }
      return Promise.resolve((match?.[1] ?? []) as readonly R[]);
    },
  };
}

const driverWith = (executor: PgExecutor) => createPgDriver({ executor });

/**
 * A driver that decodes `timestamptz` as TEXT — which is what a client without a type map does,
 * and what every statement here is written to survive by asking Postgres for epoch ms instead. It
 * answers per statement rather than per fixture: a projection that stops asking gets the text back
 * and `Number()` turns it into `NaN`, which is the whole failure mode.
 */
function textDecodingExecutor(): PgExecutor & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      const epoch = sql.includes('extract(epoch from started_at)');
      return Promise.resolve([
        {
          run_id: 'run-1',
          name: 'charge',
          status: 'completed',
          output: null,
          started_at: epoch ? '1767225600000' : '2026-01-01 00:00:00+00',
          completed_at: epoch ? '1767225601000' : '2026-01-01 00:00:01+00',
          wake_at: null,
          event: null,
          correlation_key: null,
          attempts: 1,
          error: null,
        },
      ] as unknown as readonly R[]);
    },
  };
}

/** `textDecodingExecutor`'s question, asked of the `x_jobs` projection instead. */
function textDecodingJobExecutor(): PgExecutor {
  return {
    query<R>(sql: string): Promise<readonly R[]> {
      const epoch = sql.includes('extract(epoch from run_at)');
      return Promise.resolve([
        {
          ...row(),
          run_at: epoch ? '1767225600000' : '2026-01-01 00:00:00+00',
          visible_at: null,
          created_at: epoch ? '1767225600000' : '2026-01-01 00:00:00+00',
          updated_at: epoch ? '1767225601000' : '2026-01-01 00:00:01+00',
        },
      ] as unknown as readonly R[]);
    },
  };
}

describe('the pg step store', () => {
  test('a step nobody has written yet is undefined, which is what makes step.run execute', async () => {
    const executor = executorFor();
    const store = driverWith(executor).steps;
    expect(await store?.get('run-1', 'charge')).toBeUndefined();
    expect(executor.calls[0]?.sql).toBe(SQL_STEP_GET);
    expect(executor.calls[0]?.params).toEqual(['run-1', 'charge']);
  });

  test('a recorded step comes back decoded, so a replay returns the output instead of re-running', async () => {
    const executor = executorFor({
      x_job_steps: [
        {
          run_id: 'run-1',
          name: 'charge',
          status: 'completed',
          output: { chargeId: 'ch_1' },
          started_at: '1000',
          completed_at: '2000',
          wake_at: null,
          event: null,
          correlation_key: null,
          attempts: 1,
          error: null,
        },
      ],
    });
    expect(await driverWith(executor).steps?.get('run-1', 'charge')).toEqual({
      runId: 'run-1',
      name: 'charge',
      status: 'completed',
      output: { chargeId: 'ch_1' },
      startedAt: 1000,
      completedAt: 2000,
      attempts: 1,
    });
  });

  test('put binds all eleven columns in the order the statement declares, output as JSON', async () => {
    const executor = executorFor();
    await driverWith(executor).steps?.put({
      runId: 'run-1',
      name: 'charge',
      status: 'completed',
      output: { chargeId: 'ch_1' },
      startedAt: 1000,
      completedAt: 2000,
      attempts: 3,
    });
    expect(executor.calls[0]?.sql).toBe(SQL_STEP_PUT);
    expect(executor.calls[0]?.params).toEqual([
      'run-1',
      'charge',
      'completed',
      JSON.stringify({ chargeId: 'ch_1' }),
      1000,
      2000,
      null,
      null,
      null,
      3,
      null,
    ]);
  });

  test('an absent output is the JSON literal null, never the string "undefined"', async () => {
    // `JSON.stringify(undefined)` is `undefined`, which a jsonb column rejects — so the checkpoint
    // of a step returning nothing would fail on the write rather than on anything the author did.
    const executor = executorFor();
    await driverWith(executor).steps?.put({
      runId: 'run-1',
      name: 'notify',
      status: 'completed',
      output: undefined,
      startedAt: 1000,
      attempts: 1,
    });
    expect(executor.calls[0]?.params[3]).toBe('null');
  });

  test('list projects epoch ms, so a text-decoding executor yields a number and not NaN', async () => {
    // The defect this pins: `list` was `select *`, so `started_at` arrived as the raw
    // `timestamptz` text every sibling statement asks Postgres to convert. `Number(...)` of it is
    // `NaN`, and `x jobs show` printed one per step. The fake answers what Postgres would for the
    // statement ACTUALLY issued, which is the only way a projection bug is visible to a fake.
    const executor = textDecodingExecutor();
    const [step] = (await driverWith(executor).steps?.list('run-1')) ?? [];
    expect(step?.startedAt).toBe(1767225600000);
    expect(step?.completedAt).toBe(1767225601000);
    expect(executor.calls[0]?.sql).toBe(SQL_STEP_LIST);
  });

  test('list reads one run in start order, and del/clear scope by run', async () => {
    const executor = executorFor();
    const store = driverWith(executor).steps;
    await store?.list('run-1');
    await store?.del('run-1', 'charge');
    await store?.clear('run-1');
    expect(executor.calls[0]?.sql).toContain('where run_id = $1 order by started_at');
    expect(executor.calls[1]?.sql).toContain(
      'delete from x_job_steps where run_id = $1 and name = $2',
    );
    expect(executor.calls[1]?.params).toEqual(['run-1', 'charge']);
    expect(executor.calls[2]?.sql).toContain('delete from x_job_steps where run_id = $1');
    expect(executor.calls[2]?.params).toEqual(['run-1']);
  });
});

describe('the pg lease store — fleet-wide slots', () => {
  test('a limit of zero takes no slot AND issues no statement', async () => {
    // A cap of 0 means "run none of these". Asking the database first would let a race hand out a
    // slot for a job the fleet is not allowed to run at all.
    const executor = executorFor();
    expect(
      await driverWith(executor).leases?.acquire('sendInvite', 0, 30_000, 'w-1'),
    ).toBeUndefined();
    expect(
      await driverWith(executor).leases?.acquire('sendInvite', -1, 30_000, 'w-1'),
    ).toBeUndefined();
    expect(executor.calls).toHaveLength(0);
  });

  test('a full cap answers undefined — no row means every slot is taken', async () => {
    const executor = executorFor();
    expect(
      await driverWith(executor).leases?.acquire('sendInvite', 2, 30_000, 'w-1'),
    ).toBeUndefined();
    expect(executor.calls[0]?.sql).toBe(SQL_LEASE_ACQUIRE);
    expect(executor.calls[0]?.params).toEqual(['sendInvite', 'w-1', 2, 30_000]);
  });

  test('a granted slot arrives as a NUMBER even when the client typed the column as text', async () => {
    const executor = executorFor({ x_job_leases: [{ slot: '1' }] });
    expect(await driverWith(executor).leases?.acquire('sendInvite', 2, 30_000, 'w-1')).toEqual({
      key: 'sendInvite',
      slot: 1,
      holder: 'w-1',
    });
  });

  test('renew is true only while the row is still this holder`s', async () => {
    const held = { key: 'sendInvite', slot: 1, holder: 'w-1' };
    const kept = executorFor({ x_job_leases: [{ slot: 1 }] });
    expect(await driverWith(kept).leases?.renew(held, 30_000)).toBe(true);
    expect(kept.calls[0]?.sql).toBe(SQL_LEASE_RENEW);
    expect(kept.calls[0]?.params).toEqual(['sendInvite', 1, 'w-1', 30_000]);

    const lost = executorFor();
    expect(await driverWith(lost).leases?.renew(held, 30_000)).toBe(false);
  });

  test('release names key, slot AND holder, so a worker cannot free another worker`s slot', async () => {
    const executor = executorFor();
    await driverWith(executor).leases?.release({ key: 'sendInvite', slot: 1, holder: 'w-1' });
    expect(executor.calls[0]?.sql).toBe(SQL_LEASE_RELEASE);
    expect(executor.calls[0]?.params).toEqual(['sendInvite', 1, 'w-1']);
  });

  test('held counts only unexpired rows, and an empty answer is 0 rather than NaN', async () => {
    const counted = executorFor({ 'count(*)': [{ n: '3' }] });
    expect(await driverWith(counted).leases?.held('sendInvite')).toBe(3);
    expect(counted.calls[0]?.sql).toContain('expires_at > now()');

    const empty = executorFor();
    expect(await driverWith(empty).leases?.held('sendInvite')).toBe(0);
  });
});

const row = (overrides: Partial<JobRow> = {}): JobRow => ({
  id: 'job-1',
  name: 'sendInvite',
  queue: 'mail',
  input: null,
  idempotency_key: 'invite:1',
  run_id: 'run-1',
  attempt: 0,
  max_attempts: 5,
  state: 'ready',
  tenant_id: null,
  last_error: null,
  claimed_by: null,
  run_at: '1000',
  visible_at: null,
  created_at: '900',
  updated_at: '1000',
  ...overrides,
});

describe('the pg driver`s introspection', () => {
  test('an id nobody queued is undefined, not a throw', async () => {
    const executor = executorFor();
    expect(await driverWith(executor).introspect?.job('job-404')).toBeUndefined();
    expect(executor.calls[0]?.params).toEqual(['job-404']);
  });

  test('every whole-row read projects epoch ms, so a text-decoding client never yields NaN', async () => {
    // Four of these were `select *` / `returning *`. `x jobs ls` and `x jobs show` then printed
    // `NaN` for `runAt`, `createdAt` and `updatedAt` against any executor whose client decodes
    // `timestamptz` as text — which is every client without a type map, and `PgExecutor` accepts
    // all of them. `SQL_CLAIM` had always asked Postgres for the conversion; these had not.
    const introspect = driverWith(textDecodingJobExecutor()).introspect;
    const reads = [
      await introspect?.job('job-1'),
      (await introspect?.list())?.[0],
      (await introspect?.deadLetters())?.[0],
      await introspect?.requeue('job-1'),
      await introspect?.cancel?.('job-1'),
    ];
    for (const record of reads) {
      expect(record?.runAt).toBe(1767225600000);
      expect(record?.createdAt).toBe(1767225600000);
      expect(record?.updatedAt).toBe(1767225601000);
    }
  });

  test('an unfiltered list passes three nulls and the default limit', async () => {
    // Every predicate is `$n::text is null or col = $n`, so a filter nobody set has to arrive as
    // null — an omitted parameter would make the statement fail rather than match everything.
    const executor = executorFor({ 'from x_jobs': [row()] });
    const jobs = await driverWith(executor).introspect?.list();
    expect(executor.calls[0]?.params).toEqual([null, null, null, 100]);
    expect(jobs?.map((job) => job.id)).toEqual(['job-1']);
  });

  test('a filtered list binds queue, name, state and limit in that order', async () => {
    const executor = executorFor({ 'from x_jobs': [] });
    await driverWith(executor).introspect?.list({
      queue: 'mail',
      name: 'sendInvite',
      state: 'dead',
      limit: 5,
    });
    expect(executor.calls[0]?.params).toEqual(['mail', 'sendInvite', 'dead', 5]);
  });

  test('deadLetters reads the dead state newest-first, defaulting to 100', async () => {
    const executor = executorFor({ 'from x_jobs': [row({ state: 'dead' })] });
    const dead = await driverWith(executor).introspect?.deadLetters();
    expect(executor.calls[0]?.sql).toContain("where state = 'dead' order by updated_at desc");
    expect(executor.calls[0]?.params).toEqual([100]);
    expect(dead?.[0]?.state).toBe('dead');
  });

  test('requeue resets the attempt counter and returns the updated row', async () => {
    const executor = executorFor({ 'update x_jobs': [row({ state: 'ready', attempt: 0 })] });
    const record = await driverWith(executor).introspect?.requeue('job-1');
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.sql).toContain("set state = 'ready', attempt = 0");
    expect(record?.state).toBe('ready');
  });

  test('requeue --from-step deletes THAT step first, keyed by the job`s run id', async () => {
    // The delete has to name the run, not the job: steps are keyed by run_id, and a requeue that
    // dropped nothing would replay straight past the step the operator asked to redo.
    const executor = executorFor({
      'where id = $1': [row({ run_id: 'run-9' })],
      'delete from x_job_steps': [],
      'update x_jobs': [row({ state: 'ready' })],
    });
    await driverWith(executor).introspect?.requeue('job-1', { fromStep: 'charge' });
    expect(executor.calls.map((call) => call.sql.trim().split(' ')[0])).toEqual([
      'select',
      'delete',
      'update',
    ]);
    expect(executor.calls[1]?.params).toEqual(['run-9', 'charge']);
  });

  test('requeueing an id that does not exist is X_DRIVER_UNAVAILABLE, never a silent undefined', async () => {
    const executor = executorFor();
    await expect(driverWith(executor).introspect?.requeue('job-404')).rejects.toThrow(
      DriverUnavailableError,
    );
    await expect(driverWith(executor).introspect?.requeue('job-404')).rejects.toThrow(
      /job job-404 does not exist/,
    );
  });

  test('cancel answers the cancelled row, and undefined for a job no longer cancellable', async () => {
    const cancelled = executorFor({ x_jobs: [row({ state: 'dead', last_error: 'cancelled' })] });
    const record = await driverWith(cancelled).introspect?.cancel?.('job-1', 'operator');
    expect(cancelled.calls[0]?.sql).toBe(SQL_CANCEL);
    expect(cancelled.calls[0]?.params).toEqual(['job-1', 'operator']);
    expect(record?.lastError).toBe('cancelled');

    const gone = executorFor();
    expect(await driverWith(gone).introspect?.cancel?.('job-1')).toBeUndefined();
    expect(gone.calls[0]?.params).toEqual(['job-1', null]);
  });
});

describe('the pg driver`s queue stats', () => {
  test('every count is coerced and the oldest-ready age is rounded to a whole millisecond', async () => {
    const executor = executorFor({
      x_jobs: [
        {
          queue: 'mail',
          ready: '4',
          delayed: '1',
          running: 2,
          suspended: '0',
          dead: '3',
          oldest_ready_ms: '1200.6',
        },
      ],
    });
    expect(await driverWith(executor).stats()).toEqual([
      {
        queue: 'mail',
        ready: 4,
        delayed: 1,
        running: 2,
        suspended: 0,
        dead: 3,
        oldestReadyMs: 1201,
      },
    ]);
    expect(executor.calls[0]?.sql).toBe(SQL_STATS);
    expect(executor.calls[0]?.params).toEqual([]);
  });
});
