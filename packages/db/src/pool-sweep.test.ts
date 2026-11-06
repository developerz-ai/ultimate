// Single responsibility: a statement nobody answers, against a fake pool that never does — the miss
// rejects, the pool is replaced, the old one is closed in the driver's own seconds, and `0` means no
// deadline. The proxy probe on a real server is `client-wedge.live.test.ts`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { collectMetrics, type Scheduler, setLogSink } from '@ultimat3/core';
import { postgresClient } from './client';
import { type DbError, dbUnavailable } from './errors';
import { SWEEP_INTERVAL_MS, UNANSWERED_GRACE_MS } from './pool-sweep';
import { sql } from './sql';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

interface FakePool {
  readonly closes: ({ readonly timeout?: number } | undefined)[];
  readonly sent: string[];
  readonly channels: string[];
  readonly answers: ((value: unknown) => void)[];
  closeRefuses: boolean;
  /** What a statement that never answered does when its pool closes. */
  rejectOnClose: boolean;
  readonly pending: ((error: unknown) => void)[];
}

function installPools(): FakePool[] {
  const pools: FakePool[] = [];
  host.Bun.SQL = class {
    readonly state: FakePool = {
      closes: [],
      sent: [],
      channels: [],
      answers: [],
      closeRefuses: false,
      rejectOnClose: false,
      pending: [],
    };
    constructor() {
      pools.push(this.state);
    }
    unsafe(text: string): Promise<unknown> {
      this.state.sent.push(text);
      return new Promise((resolve, reject) => {
        this.state.answers.push(resolve);
        this.state.pending.push(reject);
      });
    }
    reserve(): Promise<unknown> {
      return Promise.resolve({ unsafe: this.unsafe.bind(this), release: () => undefined });
    }
    close(options?: { readonly timeout?: number }): Promise<void> {
      this.state.closes.push(options);
      if (this.state.rejectOnClose) {
        for (const reject of this.state.pending) reject(dbUnavailable('closed under it'));
      }
      if (this.state.closeRefuses) return Promise.reject(dbUnavailable('would not close'));
      return Promise.resolve();
    }
    async listen(channel: string): Promise<{ unlisten(): Promise<void> }> {
      this.state.channels.push(channel);
      return { unlisten: async () => undefined };
    }
  };
  return pools;
}

/** The sweep's one source of time, fired by the test. `until` counts ticks from the start, in ms. */
function manualTime(): {
  readonly schedule: Scheduler;
  armed(): number;
  step(): void;
  until(ms: number): void;
} {
  let elapsed = 0;
  // One entry per ARMING, even of one function: two timers on one tick are the bug to see.
  const armed = new Set<{ readonly fn: () => void }>();
  const time = {
    schedule: ((fn) => {
      const arming = { fn };
      armed.add(arming);
      return () => armed.delete(arming);
    }) satisfies Scheduler,
    armed: () => armed.size,
    step: () => {
      elapsed += SWEEP_INTERVAL_MS;
      for (const arming of [...armed]) {
        armed.delete(arming);
        arming.fn();
      }
    },
    until: (ms: number) => {
      while (elapsed < ms) time.step();
    },
  };
  return time;
}

const client = (statementTimeoutMs: number, time: ReturnType<typeof manualTime>) =>
  postgresClient({
    url: TEST_URL,
    role: 'web',
    profile: { statementTimeoutMs, max: 4 },
    schedule: time.schedule,
  });

/** Rejections take a turn of the microtask queue to reach the awaiter. */
const settled = (): Promise<void> => Bun.sleep(0);

const logged: string[] = [];
let previousSink: ReturnType<typeof setLogSink>;
const linesNaming = (event: string): number =>
  logged.filter((line) => line.includes(`"${event}"`)).length;

beforeEach(() => {
  logged.length = 0;
  previousSink = setLogSink((line) => logged.push(line));
});

afterEach(() => {
  setLogSink(previousSink);
  host.Bun.SQL = realBunSql;
});

describe('a statement nobody answers', () => {
  test('rejects past the bound plus the grace, and the next statement is on a new pool', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);

    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    // A statement began somewhere inside its first tick, so the bound is one tick further off.
    time.until(1_000 + UNANSWERED_GRACE_MS);
    await settled();
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closes).toEqual([]);

    time.step();
    const caught = (await hung) as DbError;
    expect(caught.code).toBe('X_DB_UNAVAILABLE');
    expect(caught.cause).toContain('6000ms');
    expect(caught.cause).toContain("select 'hung'");
    expect(caught.cause).toContain('may have landed');

    // SECONDS: the driver reads this field that way, and `1000` is seventeen minutes.
    expect(pools[0]?.closes).toEqual([{ timeout: 1 }]);
    expect(pools).toHaveLength(1);

    const next = db.query(sql`select 'next'`);
    expect(pools).toHaveLength(2);
    expect(pools[1]?.sent).toEqual(["select 'next'"]);
    void next.catch(() => undefined);
    expect(linesNaming('db.pool.retired')).toBe(1);
  });

  test('statementTimeoutMs 0 has no deadline and arms no timer', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(0, time);

    let done = false;
    void db
      .query(sql`select pg_sleep(86400)`)
      .catch(() => undefined)
      .finally(() => {
        done = true;
      });
    expect(time.armed()).toBe(0);
    time.until(86_400_000);
    await settled();

    expect(done).toBe(false);
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closes).toEqual([]);
  });

  test('a statement that answered is forgotten, and an idle client arms nothing', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    expect(time.armed()).toBe(1);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await hung;
    expect(time.armed()).toBe(0);

    // The answered path: past its deadline nothing is judged, because nothing is left to judge.
    const answering = pools.length;
    const next = db.query(sql`select 'answered'`);
    const pool = pools[answering];
    expect(pool).toBeDefined();
    pool?.answers.shift()?.([]);
    await next;
    time.step();
    await settled();
    expect(pool?.closes).toEqual([]);
    expect(time.armed()).toBe(0);
  });

  test('every overdue statement rejects at once and one miss retires one pool', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);

    const first = db.query(sql`select 1`).catch((error: unknown) => error);
    const second = db.query(sql`select 2`).catch((error: unknown) => error);
    // No per-statement timer: this is what the sweep exists to avoid paying.
    expect(time.armed()).toBe(1);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);

    expect(await first).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    expect(await second).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    expect(pools[0]?.closes).toHaveLength(1);
    expect(linesNaming('db.pool.retired')).toBe(1);
  });

  test('a straggler from an already-retired pool rejects without retiring its successor', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);

    const old = db.query(sql`select 'old'`).catch((error: unknown) => error);
    time.until(2_000);
    const young = db.query(sql`select 'young'`).catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    expect(await old).toMatchObject({ code: 'X_DB_UNAVAILABLE' });

    const fresh = db.query(sql`select 'fresh'`).catch((error: unknown) => error);
    expect(pools).toHaveLength(2);
    // `young` went out on pool 0 and misses after it is gone: pool 1 is not its to retire.
    time.until(2_000 + 1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    expect(await young).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    expect(pools[1]?.closes).toEqual([]);

    time.until(9_000 + 1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await fresh;
  });

  test('age is the ticks that fired, so a frozen process judges nobody and reads no clock', async () => {
    // After a long GC or a SIGSTOP the answer is sitting in the socket, unread. A clock would call
    // that statement late on the first tick after the thaw and throw a healthy pool away; here the
    // whole freeze is one tick. No clock also keeps the funnel's promise (`observe.test.ts`).
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const clock = spyOn(performance, 'now');
    try {
      const statement = db.query(sql`select 'frozen'`).catch((error: unknown) => error);
      time.step();
      await settled();
      expect(pools[0]?.closes).toEqual([]);
      expect(clock).not.toHaveBeenCalled();
      time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
      await statement;
    } finally {
      clock.mockRestore();
    }
  });

  test('a late rejection from the closed pool is swallowed, not unhandled', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    if (pools[0] !== undefined) pools[0].rejectOnClose = true;
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    // The miss wins the race: the caller reads why, not "closed under it".
    expect(((await hung) as DbError).cause).toContain('may have landed');
    await settled();
  });

  test('a close that rejects is reported and costs the caller nothing', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    if (pools[0] !== undefined) pools[0].closeRefuses = true;
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);

    expect(await hung).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    await settled();
    expect(linesNaming('db.pool.retire_failed')).toBe(1);
  });

  test('a statement on a pin has the same deadline, and retires the pool the same way', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const pin = await db.reserve();

    const hung = pin.query(sql`select 'pinned'`).catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS);
    await settled();
    expect(pools[0]?.closes).toEqual([]);
    time.step();

    expect(((await hung) as DbError).cause).toContain("select 'pinned'");
    expect(pools[0]?.closes).toEqual([{ timeout: 1 }]);
    pin.release();
  });

  test("a retired pool's ceiling leaves db_pool_max, and the new one takes its place", async () => {
    installPools();
    const time = manualTime();
    const max = (): number =>
      collectMetrics().metrics.find((metric) => metric.descriptor.name === 'db_pool_max')?.points[0]
        ?.value ?? 0;
    const db = client(1_000, time);
    const before = max();
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    expect(max()).toBe(before + 4);

    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await hung;
    expect(max()).toBe(before);

    void db.query(sql`select 'next'`).catch(() => undefined);
    expect(max()).toBe(before + 4);
    await db.close();
    expect(max()).toBe(before);
  });

  test('a statement queued behind a retired pool runs on the new one, never sent twice', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = postgresClient({
      url: TEST_URL,
      role: 'web',
      profile: { statementTimeoutMs: 1_000, max: 1, acquireTimeoutMs: 0 },
      schedule: time.schedule,
    });

    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    const queued = db.query(sql`select 'queued'`);
    expect(pools[0]?.sent).toEqual(["select 'hung'"]);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await hung;
    await settled();

    // Handed over rather than refused: it was never sent, so it can be late and never doubled.
    expect(pools).toHaveLength(2);
    expect(pools[0]?.sent).toEqual(["select 'hung'"]);
    expect(pools[1]?.sent).toEqual(["select 'queued'"]);
    pools[1]?.answers.shift()?.([]);
    expect(await queued).toEqual([]);
  });

  test('a pin left on a retired pool costs the new pool nothing', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = postgresClient({
      url: TEST_URL,
      role: 'web',
      profile: { statementTimeoutMs: 1_000, max: 2, acquireTimeoutMs: 0 },
      schedule: time.schedule,
    });
    const pin = await db.reserve();
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await hung;

    const first = db.query(sql`select 1`);
    const second = db.query(sql`select 2`);
    expect(pools[1]?.sent).toEqual(['select 1', 'select 2']);
    pin.release();
    for (const answer of pools[1]?.answers ?? []) answer([]);
    await Promise.all([first, second]);
  });

  test('a LISTEN held on the retired pool is dialled again on the new one', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    await db.listen('x_jobs_wake', () => undefined);

    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await hung;
    await settled();

    expect(pools[1]?.channels).toEqual(['x_jobs_wake']);
  });

  test('close() retires nothing afterwards: a statement outliving it only rejects', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(1_000, time);
    const hung = db.query(sql`select 'hung'`).catch((error: unknown) => error);
    await db.close();
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);

    expect(await hung).toMatchObject({ code: 'X_DB_UNAVAILABLE' });
    expect(pools[0]?.closes).toHaveLength(1);
    expect(linesNaming('db.pool.retired')).toBe(0);
  });
});
