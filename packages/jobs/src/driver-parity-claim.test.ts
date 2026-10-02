// The claim's second arm and the answers beside it, pinned where `driver-parity.test.ts` pins the
// rest: the memory driver's BEHAVIOUR and the pg statement that has to mean the same thing, in one
// test, so neither side moves alone. Its own file because that one sits at the size ceiling; the
// same scenarios against a real Postgres are `driver-pg-lifecycle.job.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT, LIVE_STATES } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_CANCEL, SQL_CLAIM, SQL_FIND_LIVE_BY_KEY, SQL_NACK, SQL_STATS } from './driver-pg-sql';
import { isFinalAttempt } from './retry';

const TTL_MS = 30_000;

/** A `JobRow` as `SQL_CLAIM` answers one, in the state the arm that returned it wrote. */
const claimRow = (id: string, state: 'running' | 'dead'): unknown => ({
  id,
  name: 'sync',
  queue: 'default',
  input: {},
  idempotency_key: `sync:${id}`,
  run_id: `run-${id}`,
  attempt: state === 'dead' ? 3 : 1,
  max_attempts: 3,
  state,
  tenant_id: null,
  last_error: state === 'dead' ? LEASE_LAPSED_FINAL_ATTEMPT : null,
  claimed_by: state === 'dead' ? null : 'w1',
  claims: state === 'dead' ? 3 : 1,
  traceparent: null,
  enqueued_by: null,
  run_at: '0',
  visible_at: state === 'dead' ? null : '30000',
  created_at: '0',
  updated_at: '0',
});

const executorAnswering = (rows: readonly unknown[]): PgExecutor => ({
  query: <R>(): Promise<readonly R[]> => Promise.resolve(rows as readonly R[]),
});

describe('a lease that lapses on the final attempt is buried by the claim, in both', () => {
  test('the comparison is the one `nextRetry` stops on, spelled in the statement', () => {
    // `attempt` is the attempts a row has HAD: at `max_attempts` there is no next one.
    expect(isFinalAttempt({ attempts: 3 }, 3)).toBe(true);
    expect(isFinalAttempt({ attempts: 3 }, 2)).toBe(false);
    expect(SQL_CLAIM).toContain("(state = 'running' and attempt >= max_attempts) as exhausted");
    // Only a row the pick LOCKED is buried, and only one it did not bury is claimed.
    expect(SQL_CLAIM).toContain('where j.id = p.id and p.exhausted');
    expect(SQL_CLAIM).toContain('where j.id = p.id and not p.exhausted');
    expect(SQL_CLAIM).toContain('for update skip locked');
  });

  test('the row says why, in the one text both drivers write, and holds no claim', () => {
    expect(SQL_CLAIM).toContain(`last_error       = '${LEASE_LAPSED_FINAL_ATTEMPT}'`);
    expect(SQL_CLAIM).toContain('claimed_by       = null');
    expect(SQL_CLAIM).toContain('last_error_stack = null');
    // Spliced into SQL as a literal, and into a file `dev-queue.ts` splits on `;`.
    expect(LEASE_LAPSED_FINAL_ATTEMPT).not.toMatch(/['";\\]/);
    expect(LEASE_LAPSED_FINAL_ATTEMPT).toContain('lease lapsed');
  });

  test('the burial is counted in the statement that made it, as every settle is', () => {
    expect(SQL_CLAIM).toContain('insert into x_job_counters (job, bucket_ms, bucket_start, dead');
    // One counter row per job NAME: two buried rows of one job in one pass are one upsert.
    expect(SQL_CLAIM).toContain('group by name');
    // `retry.deadLetter: false` is the CALLER's knowledge ($5): those rows are buried `failed`.
    expect(SQL_CLAIM).toContain("case when j.name = any($5::text[]) then 'failed' else 'dead' end");
    expect(SQL_CLAIM).toContain("(count(*) filter (where state = 'failed'))::int");
  });

  test('the pg driver hands back the claims and REPORTS the burials, told apart by state', async () => {
    const rows = [claimRow('a', 'running'), claimRow('b', 'dead'), claimRow('c', 'running')];
    const calls: (readonly JobRecord[])[] = [];
    const claimed = await createPgDriver({ executor: executorAnswering(rows) }).claim({
      queues: ['default'],
      limit: 5,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'w1',
      onExhausted: (dead) => {
        calls.push(dead);
      },
    });
    expect(claimed.map((row) => row.id)).toEqual(['a', 'c']);
    expect(claimed.every((row) => row.state === 'running')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((row) => [row.id, row.state, row.lastError])).toEqual([
      ['b', 'dead', LEASE_LAPSED_FINAL_ATTEMPT],
    ]);
  });

  test('a pass that buried nothing reports nothing, and no listener is still not a claim', async () => {
    let reported = 0;
    const onExhausted = (): void => {
      reported += 1;
    };
    const base = { queues: ['default'], limit: 5, visibilityTimeoutMs: TTL_MS, workerId: 'w1' };
    const clean = createPgDriver({ executor: executorAnswering([claimRow('a', 'running')]) });
    expect(await clean.claim({ ...base, onExhausted })).toHaveLength(1);
    expect(reported).toBe(0);
    // Nobody listening: the dead row is still not handed out as work.
    const burying = createPgDriver({ executor: executorAnswering([claimRow('b', 'dead')]) });
    expect(await burying.claim(base)).toEqual([]);

    const clock = frozenClock(1_700_000_000_000);
    const memory = createMemoryDriver({ clock });
    const { id } = await memory.enqueue({
      name: 'sync',
      queue: 'default',
      input: {},
      idempotencyKey: 'sync:1',
      maxAttempts: 1,
    });
    expect(await memory.claim({ ...base, onExhausted })).toHaveLength(1);
    expect(reported).toBe(0);
    clock.advance(TTL_MS + 1);
    expect(await memory.claim(base)).toEqual([]);
    expect((await memory.introspect?.job(id))?.state).toBe('dead');
  });

  test('a paused queue is neither claimed nor buried: the pick skips it before either arm', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const memory = createMemoryDriver({ clock });
    const { id } = await memory.enqueue({
      name: 'sync',
      queue: 'default',
      input: {},
      idempotencyKey: 'sync:1',
      maxAttempts: 1,
    });
    const base = { queues: ['default'], limit: 5, visibilityTimeoutMs: TTL_MS, workerId: 'w1' };
    await memory.claim(base);
    clock.advance(TTL_MS + 1);
    await memory.introspect?.pauseQueue('default');
    expect(await memory.claim(base)).toEqual([]);
    expect((await memory.introspect?.job(id))?.state).toBe('running');
    // The pause is read by the pick, above both arms.
    expect(SQL_CLAIM).toContain('x_job_pauses');
    expect(SQL_CLAIM).toContain('buried as');
    expect(SQL_CLAIM.indexOf('x_job_pauses')).toBeLessThan(SQL_CLAIM.indexOf('buried as'));
  });
});

describe('the statements beside it say what the memory driver does', () => {
  test('cancel is fenced on the live states — the set the idempotency index reads', () => {
    const live = [...LIVE_STATES].map((state) => `'${state}'`).join(', ');
    expect(live).toBe("'ready', 'delayed', 'running', 'suspended'");
    expect(SQL_CANCEL).toContain(`where id = $1 and state in (${live})`);
    expect(SQL_FIND_LIVE_BY_KEY).toContain(`state in (${live})`);
  });

  test('stats orders queues by code unit', () => {
    expect(SQL_STATS).toContain('order by queue collate "C"');
  });

  test('a nack that records an error replaces the stack, even with none', () => {
    expect(SQL_NACK).toContain(
      'last_error_stack = case when $5::text is null then last_error_stack else $7::text end',
    );
  });
});
