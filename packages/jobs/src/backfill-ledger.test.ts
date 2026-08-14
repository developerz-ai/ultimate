// The ledger in isolation: what a row means, what "the same backfill" means, and what a completed
// row decides. `backfill.test.ts` owns the pass that writes them.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { BackfillRun } from './backfill-ledger';
import {
  BACKFILL_STATUSES,
  backfillChecksum,
  createMemoryBackfillLedger,
  decideBackfill,
  isBackfillStatus,
} from './backfill-ledger';
import {
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_START,
  SQL_JOBS_TABLE,
} from './driver-pg-sql';

const completed = (fields: Partial<BackfillRun> = {}): BackfillRun => ({
  runId: 'run-1',
  name: 'rewrite-titles',
  checksum: 'aaaa',
  status: 'completed',
  appVersion: '1.2.0',
  rows: 10,
  cursor: null,
  startedAt: 1,
  completedAt: 2,
  ...fields,
});

describe('BackfillStatus', () => {
  test('the runtime list IS the declaration — nothing restates the three', () => {
    // `BackfillStatus` is derived from this array, so a status added here is a status
    // `x db backfill --status` accepts without a second list to remember to edit.
    expect([...BACKFILL_STATUSES]).toEqual(['running', 'completed', 'failed']);
    for (const status of BACKFILL_STATUSES) expect(isBackfillStatus(status)).toBe(true);
  });

  test('a string nothing in the ledger can record is refused, not cast', () => {
    for (const value of ['done', 'RUNNING', '', 'complete']) {
      expect(isBackfillStatus(value)).toBe(false);
    }
  });
});

describe('backfillChecksum', () => {
  const source = (): number => 1;
  const handle = (): number => 2;

  test('is a stable 32-character hash of the two bodies', () => {
    const first = backfillChecksum(source, handle);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(backfillChecksum(source, handle)).toBe(first);
  });

  test('moves when either body moves', () => {
    const base = backfillChecksum(source, handle);
    expect(backfillChecksum((): number => 99, handle)).not.toBe(base);
    expect(backfillChecksum(source, (): number => 99)).not.toBe(base);
  });

  test('the two bodies are delimited, never concatenated', () => {
    // Raw concatenation hashes a BOUNDARY rather than a pair: `ab` + `c` and `a` + `bc` are one
    // string, so a statement moving from `handle` into `source` could leave the checksum where it
    // was. Asserted against the naive spelling, because no pair of REAL functions can demonstrate
    // the collision — a body cannot be cut anywhere and still parse on both sides.
    const naive = new Bun.CryptoHasher('sha256')
      .update(`${source.toString()}${handle.toString()}`)
      .digest('hex')
      .slice(0, 32);
    expect(backfillChecksum(source, handle)).not.toBe(naive);
  });
});

describe('decideBackfill', () => {
  test('a name the ledger has never completed runs', () => {
    expect(decideBackfill(undefined, 'aaaa', false)).toEqual({ run: true, changed: false });
  });

  test('a completed name is a no-op', () => {
    const previous = completed();
    expect(decideBackfill(previous, 'aaaa', false)).toEqual({
      run: false,
      previous,
      changed: false,
    });
  });

  test('force runs it again and still names what it is rerunning', () => {
    const previous = completed();
    expect(decideBackfill(previous, 'aaaa', true)).toEqual({ run: true, previous, changed: false });
  });

  test('a definition that moved warns — it does not run, and it does not refuse', () => {
    const previous = completed({ checksum: 'bbbb' });
    const verdict = decideBackfill(previous, 'aaaa', false);
    // `changed` is the warning; `run: false` is still the answer. Only force overrides.
    expect(verdict).toEqual({ run: false, previous, changed: true });
  });
});

describe('the memory ledger', () => {
  const ledger = () => createMemoryBackfillLedger(frozenClock(new Date('2026-08-14T00:00:00Z')));
  const opened = { runId: 'run-1', name: 'sweep', checksum: 'aaaa', appVersion: '1.2.0' };

  test('start opens a running row at zero', async () => {
    const store = ledger();
    await store.start(opened);
    expect(await store.list()).toEqual([
      { ...opened, status: 'running', rows: 0, cursor: null, startedAt: Date.parse('2026-08-14') },
    ]);
  });

  test('progress moves the row and completion clears the cursor', async () => {
    const store = ledger();
    await store.start(opened);
    await store.progress('run-1', { rows: 6, cursor: 'c6' });
    expect((await store.list())[0]).toMatchObject({ rows: 6, cursor: 'c6', status: 'running' });

    await store.finish('run-1', { status: 'completed', rows: 10 });
    expect((await store.list())[0]).toMatchObject({ rows: 10, cursor: null, status: 'completed' });
  });

  test('a failure keeps its cursor, and the next attempt adopts the same row', async () => {
    const store = ledger();
    await store.start(opened);
    await store.progress('run-1', { rows: 6, cursor: 'c6' });
    await store.finish('run-1', { status: 'failed', rows: 6 });
    // Where a pass stopped is the first thing anyone asks about a failed one.
    expect((await store.list())[0]).toMatchObject({ status: 'failed', cursor: 'c6', rows: 6 });

    await store.start(opened);
    const adopted = (await store.list())[0];
    expect(adopted).toMatchObject({ status: 'running', cursor: 'c6', rows: 6 });
    // `startedAt` is when the PASS began, not this attempt.
    expect(adopted?.startedAt).toBe(Date.parse('2026-08-14'));
    expect(await store.list()).toHaveLength(1);
    // `finish` stamps `completedAt` for `failed` too, so the attempt that adopts the row has to
    // clear it — a running pass carrying a completion time in the past is what every surface
    // reading this row would print.
    expect(adopted?.completedAt).toBeUndefined();
  });

  test('a rerun is a new row, never an edit of the one it reruns', async () => {
    const store = ledger();
    await store.start(opened);
    await store.finish('run-1', { status: 'completed', rows: 10 });
    await store.start({ ...opened, runId: 'run-2' });

    const rows = await store.list({ name: 'sweep' });
    expect(rows.map((run) => run.runId)).toEqual(['run-2', 'run-1']);
    expect(rows.map((run) => run.status)).toEqual(['running', 'completed']);
  });

  test('list filters by name and status and honours its limit', async () => {
    const store = ledger();
    await store.start(opened);
    await store.finish('run-1', { status: 'completed', rows: 10 });
    await store.start({ ...opened, runId: 'run-2', name: 'other' });

    expect(await store.list({ name: 'other' })).toHaveLength(1);
    expect((await store.list({ status: 'completed' }))[0]?.runId).toBe('run-1');
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  test('a write to a run nobody opened is a no-op, not a phantom row', async () => {
    const store = ledger();
    await store.progress('never-started', { rows: 5, cursor: 'c5' });
    await store.finish('never-started', { status: 'completed', rows: 5 });
    expect(await store.list()).toEqual([]);
  });
});

describe('the shipped SQL', () => {
  test('x_backfills is created wherever x_jobs is', () => {
    // `dev-queue.ts` applies this constant statement by statement, so a ledger declared anywhere
    // else would exist in production and not in `x dev`.
    expect(SQL_JOBS_TABLE).toContain('create table if not exists x_backfills');
    expect(SQL_JOBS_TABLE).toContain('run_id         uuid primary key');
    expect(SQL_JOBS_TABLE).toContain('create index if not exists x_backfills_name_idx');
  });

  test('start adopts a run rather than opening a second row for it', () => {
    expect(SQL_BACKFILL_START).toContain("on conflict (run_id) do update set status = 'running'");
  });

  test('start clears the completion time the attempt it adopts left behind', () => {
    // `SQL_BACKFILL_FINISH` stamps `completed_at` for `failed` as well as `completed`, and
    // `SQL_BACKFILL_LIST` returns the column to `x db backfill --list`, `x jobs show` and `/_x`.
    // Adopting the row without clearing it renders a running pass with a past completion time.
    expect(SQL_BACKFILL_START).toContain('completed_at = null');
    expect(SQL_BACKFILL_FINISH).toContain('completed_at   = now()');
  });

  test('only a completed pass clears its cursor', () => {
    expect(SQL_BACKFILL_FINISH).toContain(
      "last_cursor    = case when $2 = 'completed' then null else last_cursor end",
    );
  });

  test('list is newest first and reads epoch milliseconds', () => {
    expect(SQL_BACKFILL_LIST).toContain('order by started_at desc');
    expect(SQL_BACKFILL_LIST).toContain('(extract(epoch from started_at)   * 1000)::bigint');
  });
});
