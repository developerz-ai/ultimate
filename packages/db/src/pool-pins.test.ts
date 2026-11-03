// Single responsibility: a gate full of pins, told apart. Every slot a pin whose statement is past the
// bound is a dead path, and the pool is replaced on the acquire refusal; an idle pin, a pin still in
// time, or a busy pool of healthy work stays untouched. Also: a pin's two waits share one budget.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { postgresClient } from './client';
import type { DbError } from './errors';
import { SWEEP_INTERVAL_MS, UNANSWERED_GRACE_MS } from './pool-sweep';
import { sql } from './sql';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
});

interface FakePool {
  readonly sent: string[];
  readonly closes: unknown[];
  readonly answers: ((value: unknown) => void)[];
}

/** Every statement, pinned or pooled, waits for the test; `reserve()` answers at once. */
function installPools(): FakePool[] {
  const pools: FakePool[] = [];
  host.Bun.SQL = class {
    readonly state: FakePool = { sent: [], closes: [], answers: [] };
    constructor() {
      pools.push(this.state);
    }
    unsafe(text: string): Promise<unknown> {
      this.state.sent.push(text);
      return new Promise((resolve) => this.state.answers.push(resolve));
    }
    reserve(): Promise<unknown> {
      return Promise.resolve({ unsafe: this.unsafe.bind(this), release: () => undefined });
    }
    close(options?: unknown): Promise<void> {
      this.state.closes.push(options);
      return Promise.resolve();
    }
  };
  return pools;
}

/** The gate's deadline and the sweep's tick, both fired by `step`. */
function manualTime(): { schedule: Scheduler; step(): void; until(ms: number): void } {
  let elapsed = 0;
  const armed = new Set<{ readonly fn: () => void }>();
  const time = {
    schedule: ((fn) => {
      const arming = { fn };
      armed.add(arming);
      return () => armed.delete(arming);
    }) satisfies Scheduler,
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

const PAST_BOUND = 1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS;
const settled = (): Promise<void> => Bun.sleep(0);

const client = (time: ReturnType<typeof manualTime>) =>
  postgresClient({
    url: TEST_URL,
    role: 'worker',
    profile: { max: 2, statementTimeoutMs: 1_000, acquireTimeoutMs: 20 },
    schedule: time.schedule,
  });

describe('a gate full of pins', () => {
  test('every slot a pin hung past the bound: the refusal replaces the pool, and the work runs', async () => {
    // Reproduced: two pins hung on `begin`, 40 plain statements, all X_DB_POOL_EXHAUSTED for as
    // long as the probe ran, one pool built, none closed: the kernel's 15 minutes on `worker`.
    const pools = installPools();
    const time = manualTime();
    const db = client(time);
    const pins = [await db.reserve(), await db.reserve()];
    for (const pin of pins) void pin.query(sql`begin`).catch(() => undefined);
    time.until(PAST_BOUND);

    const next = db.query(sql`select 'after'`);
    time.step();
    await settled();

    expect(pools).toHaveLength(2);
    expect(pools[0]?.closes).toEqual([{ timeout: 1 }]);
    expect(pools[1]?.sent).toEqual(["select 'after'"]);
    pools[1]?.answers.shift()?.([]);
    expect(await next).toEqual([]);
    for (const pin of pins) pin.release();
  });

  test('idle pins filling the gate are a busy pool, not a dead one', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(time);
    const pins = [await db.reserve(), await db.reserve()];
    await Promise.all(
      pins.map(async (pin) => {
        const answering = pin.query(sql`select 'quick'`);
        pools[0]?.answers.shift()?.([]);
        await answering;
      }),
    );
    time.until(PAST_BOUND);

    const refused = db.query(sql`select 'next'`).catch((error: unknown) => error);
    time.step();
    expect(((await refused) as DbError).code).toBe('X_DB_POOL_EXHAUSTED');
    expect(pools).toHaveLength(1);
    expect(pools[0]?.closes).toEqual([]);
  });

  test('a pin still inside the bound keeps the pool, even beside one past it', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(time);
    const old = await db.reserve();
    void old.query(sql`begin`).catch(() => undefined);
    time.until(PAST_BOUND - 2 * SWEEP_INTERVAL_MS);
    const young = await db.reserve();
    void young.query(sql`begin`).catch(() => undefined);
    time.until(PAST_BOUND);

    const refused = db.query(sql`select 'next'`).catch((error: unknown) => error);
    time.step();
    expect(((await refused) as DbError).code).toBe('X_DB_POOL_EXHAUSTED');
    expect(pools[0]?.closes).toEqual([]);
  });

  test('a slot held by a plain statement is not a pin: the sweep owns that one', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = postgresClient({
      url: TEST_URL,
      role: 'worker',
      profile: { max: 2, statementTimeoutMs: 1_000, acquireTimeoutMs: 20 },
      schedule: time.schedule,
    });
    const pin = await db.reserve();
    void pin.query(sql`begin`).catch(() => undefined);
    time.until(PAST_BOUND - 3 * SWEEP_INTERVAL_MS);
    void db.query(sql`select 'busy'`).catch(() => undefined);

    const refused = db.query(sql`select 'next'`).catch((error: unknown) => error);
    time.step();
    expect(((await refused) as DbError).code).toBe('X_DB_POOL_EXHAUSTED');
    expect(pools[0]?.closes).toEqual([]);
  });
});

describe('reserve() on the pool that replaced a wedged one', () => {
  test('starts a fresh budget there, rather than the 1 ms the dead pool left', async () => {
    // Reproduced: every slot a hung pin, reserve() waits its whole budget, the pool is replaced,
    // and the new, healthy pool was asked for a pin with 1 ms left: X_DB_POOL_EXHAUSTED.
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let built = 0;
      const answers: (() => void)[] = [];
      host.Bun.SQL = class {
        readonly first = built++ === 0;
        unsafe(): Promise<unknown> {
          return new Promise(() => undefined);
        }
        reserve(): Promise<unknown> {
          const pin = { unsafe: this.unsafe.bind(this), release: () => undefined };
          if (this.first) return Promise.resolve(pin);
          // The new pool answers on the test's word, after a real wait inside the budget.
          return new Promise((resolve) => answers.push(() => resolve(pin)));
        }
        close(): Promise<void> {
          return Promise.resolve();
        }
      };
      const time = manualTime();
      const db = postgresClient({
        url: TEST_URL,
        role: 'worker',
        profile: { max: 2, statementTimeoutMs: 1_000, acquireTimeoutMs: 100 },
        schedule: time.schedule,
      });
      const pins = [await db.reserve(), await db.reserve()];
      for (const pin of pins) void pin.query(sql`begin`).catch(() => undefined);
      time.until(PAST_BOUND);

      // `reserveWithin` arms a real timer for what is left: its delay is the budget it was given.
      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, ms);
      }) as typeof setTimeout);
      try {
        const asked = db.reserve();
        now = 100;
        time.step();
        await settled();
        expect(built).toBe(2);
        expect(delays).toEqual([100]);
        answers.shift()?.();
        (await asked).release();
      } finally {
        timer.mockRestore();
      }
      for (const old of pins) old.release();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('reserve() under one budget', () => {
  test('what the gate spent, reserveWithin does not get again', async () => {
    // Two timers of `acquireTimeoutMs` each made `web` wait 10 s for a pin it was promised in 5.
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let reserves = 0;
      host.Bun.SQL = class {
        reserve(): Promise<unknown> {
          reserves += 1;
          if (reserves === 1) {
            return Promise.resolve({ unsafe: async () => [], release: () => undefined });
          }
          return new Promise(() => undefined);
        }
        async close(): Promise<void> {}
      };
      const time = manualTime();
      const db = postgresClient({
        url: TEST_URL,
        role: 'web',
        profile: { max: 1, acquireTimeoutMs: 100 },
        schedule: time.schedule,
      });
      const first = await db.reserve();
      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, ms);
      }) as typeof setTimeout);
      let caught: DbError;
      try {
        const second = db.reserve().catch((error: unknown) => error);
        now = 60;
        first.release();
        caught = (await second) as DbError;
      } finally {
        timer.mockRestore();
      }
      // The driver's queue got what the gate left, 40 of the 100 …
      expect(delays).toEqual([40]);
      expect(caught.code).toBe('X_DB_POOL_EXHAUSTED');
      // … and the refusal names the one budget the whole wait ran under, never the remainder.
      expect(caught.cause).toContain('within 100ms');
    } finally {
      clock.mockRestore();
    }
  });
});
