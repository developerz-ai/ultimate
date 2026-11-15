// What a scheduler round costs `x_scheduler_state` on a real Postgres, statement by statement and
// scan by scan: 43 tasks, the production shape that showed 8.8M sequential scans. One pooled
// connection, so the backend whose counters `pg_stat_force_next_flush()` publishes is the one
// that ran every statement. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, resetLifecycle, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import type { CronResolver } from './scheduler';
import { jobScheduler } from './scheduler';
import { soleLeader } from './scheduler-leader';
import { postgresSchedulerState } from './scheduler-pg';
import type { TaskHandle } from './task';
import { resetTasks, task } from './task';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_sched_stmts_live');
const TASKS = 43;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

/** Every whole minute: each task is due once per advanced minute, and never between. */
const everyMinute: CronResolver = (_cron, options) =>
  new Date(Math.floor(options.from.getTime() / MINUTE) * MINUTE + MINUTE);

function manualClock(start: number): Clock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

interface TableCounters {
  readonly seqScans: number;
  readonly indexScans: number;
  readonly updates: number;
  readonly hotUpdates: number;
}

afterEach(() => {
  resetJobs();
  resetTasks();
  resetLifecycle();
});

describe.skipIf(!hasPostgres)('live · postgres · scheduler statements per round', () => {
  let admin: PostgresClient;
  let one: PostgresClient;
  let sent: string[] = [];
  let tasks: TaskHandle[] = [];

  const probeUrl = (): string => {
    const parsed = new URL(url ?? 'postgres://localhost/postgres');
    parsed.pathname = `/${PROBE_DB}`;
    return parsed.toString();
  };
  const counting = (): PgExecutor => ({
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
      sent.push(text);
      return one.query<R>({ text, values });
    },
  });
  /** Statements that named the watermark table — reads and writes alike. */
  const stateStatements = (): number =>
    sent.filter((text) => text.includes('x_scheduler_state')).length;
  const counters = async (): Promise<TableCounters> => {
    // The cumulative counters reach the view when the backend flushes them, not per statement.
    await one.query({ text: 'select pg_stat_force_next_flush()', values: [] });
    const rows = await one.query<{ seq: string; idx: string; upd: string; hot: string }>({
      text: `select seq_scan as seq, coalesce(idx_scan, 0) as idx, n_tup_upd as upd,
                    n_tup_hot_upd as hot
               from pg_stat_user_tables where relname = 'x_scheduler_state'`,
      values: [],
    });
    return {
      seqScans: Number(rows[0]?.seq ?? 0),
      indexScans: Number(rows[0]?.idx ?? 0),
      updates: Number(rows[0]?.upd ?? 0),
      hotUpdates: Number(rows[0]?.hot ?? 0),
    };
  };
  const scheduler = (clock: Clock) =>
    jobScheduler({
      driver: postgresJobDriver({ executor: counting() }),
      state: postgresSchedulerState(counting()),
      leader: soleLeader(),
      clock,
      cron: everyMinute,
      tasks,
      tickIntervalMs: 3_600_000,
      drainOnShutdown: false,
    });

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    one = postgresClient({ url: probeUrl(), role: 'scheduler', profile: { max: 1 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await one.execute(raw(statement));
    }
  });

  beforeEach(async () => {
    await one.execute(raw('truncate x_scheduler_state, x_jobs'));
    const beat = itemJob({ run: () => Promise.resolve() });
    tasks = Array.from({ length: TASKS }, (_, index) =>
      task({
        name: `stmt-task-${String(index).padStart(2, '0')}`,
        cron: '* * * * *',
        tz: 'UTC',
        catchUp: 'run-all',
        enqueue: () => [[beat, { item: `beat-${index}` }]],
      }),
    );
    sent = [];
  });

  afterAll(async () => {
    await one.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('a restarted scheduler reads all 43 watermarks in ONE statement and one table scan', async () => {
    const clock = manualClock(T0);
    // The pod this one replaces armed every task.
    await scheduler(clock).tick();
    sent = [];
    const before = await counters();

    expect(await scheduler(clock).tick()).toEqual([]);

    // Was 43: one `SQL_SCHEDULER_STATE_GET` a task, each a sequential scan of a one-page table.
    expect(stateStatements()).toBe(1);
    const after = await counters();
    // One scan of the table in all: the planner picks the primary key for `= any($1)`, where the
    // per-task equality read was a sequential scan each.
    expect(after.seqScans - before.seqScans + (after.indexScans - before.indexScans)).toBe(1);
    // Nothing needed arming, so nothing was written.
    expect(after.updates - before.updates).toBe(0);
  });

  test('a due round fires each occurrence in one fenced, HOT statement and reads nothing', async () => {
    const clock = manualClock(T0);
    const node = scheduler(clock);
    await node.tick();
    sent = [];
    const before = await counters();

    clock.advance(MINUTE);
    expect(await node.tick()).toHaveLength(TASKS);

    // One fire a task — the occurrence, fenced on the watermark — and not one watermark read.
    expect(stateStatements()).toBe(TASKS);
    const after = await counters();
    // The fence's conflict lookups go through the primary key; nothing scans the table.
    expect(after.seqScans - before.seqScans).toBe(0);
    // Every watermark move is a heap-only update: the dead version is pruned in-page.
    expect(after.updates - before.updates).toBe(TASKS);
    expect(after.hotUpdates - before.hotUpdates).toBe(TASKS);
  });

  test('a fire the fence refuses writes no row version', async () => {
    const clock = manualClock(T0);
    const node = scheduler(clock);
    await node.tick();
    clock.advance(MINUTE);
    await node.tick();
    const before = await counters();

    // A second dispatcher, late, for the occurrence the first already fired.
    const late = await postgresSchedulerState(counting()).fire(
      postgresJobDriver({ executor: counting() }),
      { task: tasks[0]?.name ?? '', occurrenceMs: T0 + MINUTE, jobs: [] },
    );

    expect(late).toBeUndefined();
    const after = await counters();
    expect(after.updates - before.updates).toBe(0);
  });
});
