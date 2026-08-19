// J3: the scheduler shipped with a `Map` watermark and a `() => true` leader, and the only
// production caller passed neither. Two silent failures follow — a deploy at 03:02 arms to
// tomorrow and never detects the 03:00 run the previous pod dropped, and a rolling update runs
// two leaders. Both halves are pinned here.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import { createPgLeader } from './driver-pg';
import {
  SQL_ADVISORY_UNLOCK,
  SQL_LEADER_ACQUIRE,
  SQL_LEADER_RELEASE,
  SQL_SCHEDULER_STATE_MARK,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import {
  createPgLeaseLeader,
  currentLeader,
  DEFAULT_LEADER_TTL_MS,
  pgSchedulerState,
} from './scheduler-pg';

function recorder(handler: (sql: string, params: readonly unknown[]) => readonly unknown[]) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve(handler(sql, params) as readonly R[]);
    },
  };
  return { executor, calls };
}

describe('the durable scheduler watermark', () => {
  test('an absent row is `undefined`, which is what arms a task rather than firing history', async () => {
    const { executor } = recorder(() => []);
    expect(await pgSchedulerState(executor).lastFiredAt('nightlyBilling')).toBeUndefined();
  });

  test('a stored watermark survives the process — the whole point of the table', async () => {
    const { executor } = recorder(() => [{ last_fired_at: '1735700400000' }]);
    expect(await pgSchedulerState(executor).lastFiredAt('nightlyBilling')).toBe(1_735_700_400_000);
  });

  test('the watermark only moves FORWARD', () => {
    // Two rounds overlapping across a rolling restart would otherwise let the older one rewind
    // it, and every occurrence between the two values fires a second time.
    expect(SQL_SCHEDULER_STATE_MARK).toContain(
      'greatest(x_scheduler_state.last_fired_at, excluded.last_fired_at)',
    );
  });
});

describe('lease-based leader election', () => {
  test('a node that does not win the lease is NOT the leader', async () => {
    // The insert conflicts and the `where` matches neither branch, so no row comes back.
    const { executor } = recorder(() => []);
    const leader = createPgLeaseLeader({ executor, holder: 'pod-b' });
    expect(await leader.acquire()).toBe(false);
  });

  test('a node that wins it is, and acquire() doubles as the renewal', async () => {
    const { executor, calls } = recorder(() => [{ holder: 'pod-a' }]);
    const leader = createPgLeaseLeader({ executor, holder: 'pod-a', ttlMs: 30_000 });

    expect(await leader.acquire()).toBe(true);
    expect(await leader.acquire()).toBe(true);

    // Every round issues the statement: that IS the renewal, and it is how a demoted node finds
    // out. A cached `isLeader` would keep dispatching past a lease another node already took.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(SQL_LEADER_ACQUIRE);
    expect(calls[0]?.params).toEqual(['scheduler', 'pod-a', 30_000]);
  });

  test('the grant is refused for a live lease and allowed for an expired one', () => {
    // The statement is the atomicity: the primary key serialises, and the `where` is the policy.
    expect(SQL_LEADER_ACQUIRE).toContain('x_scheduler_leader.holder = excluded.holder');
    expect(SQL_LEADER_ACQUIRE).toContain('x_scheduler_leader.expires_at <= now()');
    expect(SQL_LEADER_ACQUIRE).toContain('returning holder');
  });

  test('only the holder releases it', () => {
    expect(SQL_LEADER_RELEASE).toContain('lock_key = $1 and holder = $2');
  });
});

describe('the advisory-lock leader it replaces', () => {
  test('a repeated acquire does NOT take a second refcounted grant', async () => {
    // Postgres refcounts a session advisory lock per acquisition and `release()` only ever issues
    // one unlock, so a scheduler that renews every round would leak a grant per round.
    const { executor, calls } = recorder((sql) =>
      sql === SQL_TRY_ADVISORY_LOCK ? [{ locked: true }] : [{ unlocked: true }],
    );
    const leader = createPgLeader(42, { executor });

    expect(await leader.acquire()).toBe(true);
    expect(await leader.acquire()).toBe(true);
    expect(calls.filter((call) => call.sql === SQL_TRY_ADVISORY_LOCK)).toHaveLength(1);

    await leader.release();
    await leader.release();
    expect(calls.filter((call) => call.sql === SQL_ADVISORY_UNLOCK)).toHaveLength(1);
  });
});

describe('the watermark write and the lease release', () => {
  test('markFired binds the task and the OCCURRENCE, never the wall clock', async () => {
    // The occurrence is the schedule's own instant. Writing `now()` instead would move the
    // watermark past occurrences a catch-up round has not dispatched yet.
    const { executor, calls } = recorder(() => []);
    await pgSchedulerState(executor).markFired('nightlyBilling', 1_735_700_400_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(SQL_SCHEDULER_STATE_MARK);
    expect(calls[0]?.params).toEqual(['nightlyBilling', 1_735_700_400_000]);
  });

  test('release names the holder, so a node cannot drop a lease another node now holds', async () => {
    const { executor, calls } = recorder(() => []);
    await createPgLeaseLeader({ executor, lockKey: 'sweeper', holder: 'pod-a' }).release();
    expect(calls[0]?.sql).toBe(SQL_LEADER_RELEASE);
    expect(calls[0]?.params).toEqual(['sweeper', 'pod-a']);
  });

  test('the default lock key is "scheduler" and the default ttl is DEFAULT_LEADER_TTL_MS', async () => {
    const { executor, calls } = recorder(() => []);
    await createPgLeaseLeader({ executor, holder: 'pod-a' }).acquire();
    expect(calls[0]?.params).toEqual(['scheduler', 'pod-a', DEFAULT_LEADER_TTL_MS]);
    expect(DEFAULT_LEADER_TTL_MS).toBe(30_000);
  });

  test('a holder defaulted per PROCESS is unique, never a hostname a pod reuses', async () => {
    const { executor, calls } = recorder(() => []);
    await createPgLeaseLeader({ executor }).acquire();
    await createPgLeaseLeader({ executor }).acquire();
    const [first, second] = calls.map((call) => call.params[1]);
    expect(first).not.toBe(second);
    expect(String(first)).toStartWith('scheduler-');
  });
});

describe('currentLeader', () => {
  const clock = { now: () => new Date(1_000_000), monotonic: () => 1_000_000 };

  test('an unheld key has no leader', async () => {
    const { executor, calls } = recorder(() => []);
    expect(await currentLeader(executor, 'scheduler', clock)).toBeUndefined();
    expect(calls[0]?.params).toEqual(['scheduler']);
  });

  test('a live lease answers its holder', async () => {
    const { executor } = recorder(() => [{ holder: 'pod-a', expires_at: '1000001' }]);
    expect(await currentLeader(executor, 'scheduler', clock)).toBe('pod-a');
  });

  test('an EXPIRED row is nobody — a dead pod does not keep reading as the leader', async () => {
    // The row survives its lease: expiry is what makes a crashed node reclaimable with nothing
    // to clean up, so the read has to apply the deadline the write only recorded.
    const { executor } = recorder(() => [{ holder: 'pod-a', expires_at: '1000000' }]);
    expect(await currentLeader(executor, 'scheduler', clock)).toBeUndefined();
  });

  test('the lock key defaults to "scheduler" here too, so both halves read one row', async () => {
    const { executor, calls } = recorder(() => []);
    await currentLeader(executor);
    expect(calls[0]?.params).toEqual(['scheduler']);
    expect(calls[0]?.sql).toContain('from x_scheduler_leader where lock_key = $1');
  });
});
