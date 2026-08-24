// One question, one answer, whichever driver is asked. `driver-memory.ts` is what `x dev`, every
// test in this repo and every test in an app runs against; `driver-pg.ts` is what production runs
// against — so a semantic only one of them holds is a guarantee that passes CI and breaks on
// deploy. Each case asserts the memory driver's BEHAVIOUR and the pg statement that has to mean
// the same thing, in one test, so neither side can move alone.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver, NackOptions } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_ACK, SQL_LEASE_RENEW, SQL_NACK, SQL_STATS } from './driver-pg-sql';
import { createMemoryLeaseStore } from './leases';

/**
 * The pg driver compiles its SQL against this seam, so the statement it issues is readable — and
 * its PARAMETERS with it, because a value the statement takes as `$n` (the state a nack writes) is
 * decided in the driver and is invisible in the SQL.
 */
function recordingExecutor(): PgExecutor & {
  readonly sql: string[];
  readonly params: readonly unknown[][];
} {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    query<R>(text: string, values: readonly unknown[] = []): Promise<readonly R[]> {
      sql.push(text);
      params.push([...values]);
      return Promise.resolve([] as readonly R[]);
    },
  };
}

const claimOne = (driver: JobDriver): Promise<unknown> =>
  driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' });

describe('attempt never goes below zero', () => {
  test('a suspension that does not burn an attempt cannot drive the count negative', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'sleeper',
      queue: 'default',
      input: {},
      idempotencyKey: 'sleeper:1',
      maxAttempts: 3,
    });

    // A `step.sleep` loop is one claim and one suspension per pass, and each pass gives the
    // attempt back: three of them on a fresh row is `0 -> 1 -> 0`, three times, never `-1`. A
    // negative attempt is a row `nextRetry` reads as having tries it does not have.
    for (let pass = 0; pass < 3; pass += 1) {
      await claimOne(driver);
      await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    }
    expect((await driver.introspect?.job(id))?.attempt).toBe(0);

    // Two guards, and this asks for both: the settle fence refuses a nack on a row that is not
    // `running` (a suspended row is already back on the queue), and the decrement itself has a
    // floor. Drop either and this row reaches `-1`.
    await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    expect((await driver.introspect?.job(id))?.attempt).toBe(0);
    // The floor the pg driver has always had. Both halves in one test: dropped from either side,
    // this fails.
    expect(SQL_NACK).toContain('greatest(attempt - 1, 0)');
  });
});

describe('a settled job holds no lease', () => {
  /**
   * `SQL_ACK` and `SQL_NACK` both write `visible_at = null, claimed_by = null`; the memory driver
   * patched `state` alone, so a `done` or re-queued row kept the worker id and the lease deadline
   * of the attempt that settled it. `x jobs show` reads those two columns straight off the record,
   * so `x dev` reported a finished job as still claimed by `w1` until its stale deadline passed —
   * and a re-queued row was `ready` while naming a worker that no longer holds it, which is the
   * exact state the claim scan's lease-expiry branch exists to distinguish.
   */
  test('ack clears the lease the claim stamped, as SQL_ACK does', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'settler',
      queue: 'default',
      input: {},
      idempotencyKey: 'settler:1',
      maxAttempts: 3,
    });
    await claimOne(driver);
    // The claim is what stamps them, so the test is only meaningful if it did.
    const claimed = await driver.introspect?.job(id);
    expect(claimed?.claimedBy).toBe('w1');
    expect(typeof claimed?.visibleAt).toBe('number');

    await driver.ack(id);

    const settled = await driver.introspect?.job(id);
    expect(settled?.state).toBe('done');
    expect(settled?.claimedBy).toBeUndefined();
    expect(settled?.visibleAt).toBeUndefined();
    // The pg half, in the same test, so neither side can move alone.
    expect(SQL_ACK).toContain('visible_at = null');
    expect(SQL_ACK).toContain('claimed_by = null');
  });

  test('nack does too, so a re-queued row names no worker', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'settler',
      queue: 'default',
      input: {},
      idempotencyKey: 'settler:2',
      maxAttempts: 3,
    });
    await claimOne(driver);
    await driver.nack(id, { delayMs: 0, error: 'boom' });

    const settled = await driver.introspect?.job(id);
    expect(settled?.state).toBe('ready');
    expect(settled?.lastError).toBe('boom');
    expect(settled?.claimedBy).toBeUndefined();
    expect(settled?.visibleAt).toBeUndefined();
    expect(SQL_NACK).toContain('visible_at = null');
    expect(SQL_NACK).toContain('claimed_by = null');
  });
});

describe('introspect.list answers newest first', () => {
  test('the memory driver orders by createdAt descending, as the pg statement does', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = createMemoryDriver({ clock });
    for (const key of ['oldest', 'middle', 'newest']) {
      await driver.enqueue({
        name: 'listed',
        queue: 'default',
        input: {},
        idempotencyKey: `listed:${key}`,
        maxAttempts: 1,
      });
      clock.advance(1_000);
    }

    // `x jobs ls`, `/_x`'s jobs panel and the MCP tool all read whichever driver the process
    // wired: ascending here meant an operator comparing a dev list with a production one was
    // shown two different halves of the queue.
    expect(((await driver.introspect?.list()) ?? []).map((row) => row.idempotencyKey)).toEqual([
      'listed:newest',
      'listed:middle',
      'listed:oldest',
    ]);

    const executor = recordingExecutor();
    await createPgDriver({ executor }).introspect?.list();
    expect(executor.sql.join('\n')).toContain('order by created_at desc');
  });

  test('a limit keeps the newest rows, not the oldest', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = createMemoryDriver({ clock });
    for (const key of ['a', 'b', 'c']) {
      await driver.enqueue({
        name: 'listed',
        queue: 'default',
        input: {},
        idempotencyKey: `listed:${key}`,
        maxAttempts: 1,
      });
      clock.advance(1_000);
    }

    // The limit is applied AFTER the sort in both drivers, so sorting the wrong way did not just
    // reverse the page — it returned the rows least likely to be asked about.
    expect(
      ((await driver.introspect?.list({ limit: 1 })) ?? []).map((row) => row.idempotencyKey),
    ).toEqual(['listed:c']);
  });
});

describe('a lapsed fleet slot is lost, not renewed', () => {
  test('the memory store refuses its own holder past the TTL, and the pg statement fences on it', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const store = createMemoryLeaseStore({ clock });
    const lease = await store.acquire('job:sweep', 1, 30_000, 'w1');
    if (lease === undefined) throw new TypeError('the first slot under a limit of 1 must be free');

    // A renewal INSIDE the window still lands — the fence must not turn every heartbeat into a
    // loss, which is the way "add an expiry check" goes wrong.
    clock.advance(29_000);
    expect(await store.renew(lease, 30_000)).toBe(true);

    // Past the TTL with nobody having taken the slot. `worker-fleet-slots.ts` reads `false` as
    // `X_JOB_SLOT_LOST` and cancels the run, so the two drivers answering this differently is a
    // job that survives its lapsed slot in production and is killed for it under `x dev`.
    clock.advance(30_001);
    expect(await store.renew(lease, 30_000)).toBe(false);
    expect(await store.held('job:sweep')).toBe(0);

    // The holder fence alone answers the case another worker HAS taken the slot; only an expiry
    // fence answers the case nobody has yet. Both halves in one test: drop either and this fails.
    expect(SQL_LEASE_RENEW).toContain('holder = $3');
    expect(SQL_LEASE_RENEW).toContain('expires_at > now()');
  });
});

describe('stats puts a job in exactly one bucket', () => {
  // The statement is aligned for a human reading it out of a log, so the fragment is matched
  // against a whitespace-collapsed copy rather than against the padding.
  const DELAYED_FILTER =
    "filter (where state = 'delayed' or (state = 'ready' and run_at > now())) as delayed";
  const compactStats = () => SQL_STATS.replace(/\s+/g, ' ');

  /** Enqueue one job, claim it, and settle it the way `step.sleep` or a retry settles one. */
  const settledOnce = async (key: string, options: NackOptions) => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = createMemoryDriver({ clock });
    const { id } = await driver.enqueue({
      name: 'sleeper',
      queue: 'default',
      input: {},
      idempotencyKey: key,
      maxAttempts: 3,
    });
    await claimOne(driver);
    await driver.nack(id, options);
    return (await driver.stats())[0];
  };

  test('a suspended job is suspended and NOT also delayed', async () => {
    // What `step.sleep` leaves behind: `suspended`, with `run_at` in the future. That future
    // `run_at` is what the unfenced pg filter counted a SECOND time, so the five buckets summed to
    // more rows than the table holds — and `x jobs` said one thing under `x dev` and another in
    // production, which is the number an operator sizes a worker fleet from.
    expect(
      await settledOnce('sleeper:1', { delayMs: 3_600_000, countsAsAttempt: false, park: true }),
    ).toEqual({
      queue: 'default',
      ready: 0,
      delayed: 0,
      running: 0,
      suspended: 1,
      dead: 0,
      oldestReadyMs: 0,
    });
    // The fence, in the pg statement that has to mean the same thing. `run_at > now()` alone was
    // every state's future row; only a `ready` one is genuinely waiting for its clock.
    expect(compactStats()).toContain(DELAYED_FILTER);
    expect(compactStats()).not.toContain("state = 'delayed' or run_at > now()");
  });

  test('a retrying job waiting out its backoff is delayed, in both', async () => {
    // The case the fence must NOT drop: `ready` with a future `run_at` is the backoff a retry is
    // sitting in, and it belongs in `delayed` on both sides.
    expect(await settledOnce('retry:1', { delayMs: 60_000, countsAsAttempt: true })).toEqual({
      queue: 'default',
      ready: 0,
      delayed: 1,
      running: 0,
      suspended: 0,
      dead: 0,
      oldestReadyMs: 0,
    });
    expect(compactStats()).toContain(DELAYED_FILTER);
  });

  /**
   * A limiter shed and a `step.sleep` were ONE flag: both handed the job back with
   * `countsAsAttempt: false`, and both drivers read that as `suspended`. So `stats()` counted a job
   * that is merely WAITING out of `ready` and out of `oldest_ready_ms` — the two numbers the HPA
   * and the "oldest job older than 5 minutes" page read — and under sustained overload the shed
   * fraction approaches 100%, so both signals go quiet exactly when the queue is saturated.
   */
  test('a limiter shed is still waiting, so it stays in the ready bucket, in both', async () => {
    expect(await settledOnce('shed:1', { delayMs: 0, countsAsAttempt: false })).toEqual({
      queue: 'default',
      ready: 1,
      delayed: 0,
      running: 0,
      suspended: 0,
      dead: 0,
      oldestReadyMs: 0,
    });

    // The pg half. The state is a PARAMETER of `SQL_NACK`, so the statement cannot carry the
    // mapping and the driver has to be asked for it.
    const executor = recordingExecutor();
    const pg = createPgDriver({ executor });
    await pg.nack('shed', { delayMs: 0, countsAsAttempt: false });
    await pg.nack('sleep', { delayMs: 0, countsAsAttempt: false, park: true });
    expect(executor.params.map((row) => row[1])).toEqual(['ready', 'suspended']);
    // And `countsAsAttempt` still means only the counter: neither of them burns an attempt.
    expect(executor.params.map((row) => row[2])).toEqual([false, false]);
  });
});

describe('an empty queue list is not a question', () => {
  /**
   * The divergence this case exists for: `claim({ queues: [] })` meant EVERY queue on the memory
   * driver (`wanted.size === 0 ||`) and the `default` queue on Postgres (`queues.length > 0 ?
   * queues : [DEFAULT_QUEUE]`), and `ClaimOptions.queues` documented neither. Unreached through
   * `createWorker`, which always passes exactly one queue — so the two answers could sit there
   * indefinitely, and whichever an embedder hit first became the one it wrote its deployment
   * against. Both drivers now refuse, which is the only answer that cannot be silently wrong in
   * the other's deployment: claiming every queue on a shared database is a worker taking work it
   * was never configured for, and claiming `default` is a worker that silently drains nothing.
   */
  const empty = { queues: [], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' };

  test('the memory driver refuses it', async () => {
    await expect(createMemoryDriver().claim(empty)).rejects.toThrow(/X_JOB_CLAIM_QUEUES_EMPTY/);
  });

  test('the pg driver refuses it, before it issues a statement', async () => {
    const executor = recordingExecutor();
    await expect(createPgDriver({ executor }).claim(empty)).rejects.toThrow(
      /X_JOB_CLAIM_QUEUES_EMPTY/,
    );
    // Refused in the driver, not by the database: a statement over `any('{}')` matches no row and
    // would have read as an idle queue.
    expect(executor.sql).toEqual([]);
  });

  test('one named queue still claims, in both', async () => {
    const memory = createMemoryDriver();
    await expect(claimOne(memory)).resolves.toEqual([]);
    const executor = recordingExecutor();
    await createPgDriver({ executor }).claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    expect(executor.params[0]?.[0]).toEqual(['default']);
  });
});
