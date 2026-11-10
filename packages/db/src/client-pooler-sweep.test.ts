// Single responsibility: the unanswered-statement deadline behind a pooler. `statement_timeout`
// starts only once the pooler hands the client a backend, so a statement queued in a saturated
// pooler is not a dead path, and a deadline blind to that retires every pod's pool at once.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink, type Scheduler } from '@ultimat3/core';
import { postgresClient } from './client';
import { type DbError, dbUnavailable } from './errors';
import { SWEEP_INTERVAL_MS, UNANSWERED_GRACE_MS } from './pool-sweep';
import { POOLER_WAIT_MS } from './pooler';
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

const client = (
  time: ReturnType<typeof manualTime>,
  env: Readonly<Record<string, string>>,
  poolerWaitMs?: number,
) =>
  postgresClient({
    url: TEST_URL,
    role: 'web',
    profile: { statementTimeoutMs: 1_000, max: 4 },
    schedule: time.schedule,
    env,
    ...(poolerWaitMs === undefined ? {} : { poolerWaitMs }),
  });

/** Rejections take a turn of the microtask queue to reach the awaiter. */
const settled = (): Promise<void> => Bun.sleep(0);

const logged: string[] = [];
let releaseLogSink: () => void;
const linesNaming = (event: string): number =>
  logged.filter((line) => line.includes(`"${event}"`)).length;

beforeEach(() => {
  logged.length = 0;
  releaseLogSink = installLogSink((line) => logged.push(line));
});

afterEach(() => {
  releaseLogSink();
  host.Bun.SQL = realBunSql;
});

describe('the deadline behind a pooler', () => {
  test('with no pooler it is the bound plus the grace, unchanged', async () => {
    const pools = installPools();
    const time = manualTime();
    const hung = client(time, {})
      .query(sql`select 1`)
      .catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + SWEEP_INTERVAL_MS);
    await settled();

    expect(((await hung) as DbError).code).toBe('X_DB_UNAVAILABLE');
    expect(pools[0]?.closes).toHaveLength(1);
  });

  test('a statement waiting in the pooler queue is not retired at the bound plus the grace', async () => {
    const pools = installPools();
    const time = manualTime();
    let caught: unknown;
    void client(time, { DATABASE_POOLER: 'transaction' })
      .query(sql`select 1`)
      .catch((error: unknown) => {
        caught = error;
      });
    time.until(1_000 + UNANSWERED_GRACE_MS + 10 * SWEEP_INTERVAL_MS);
    await settled();

    expect(caught).toBeUndefined();
    expect(pools[0]?.closes).toEqual([]);
    expect(linesNaming('db.pool.retired')).toBe(0);
  });

  test('past the pooler wait budget too, it is unanswered', async () => {
    const time = manualTime();
    installPools();
    const hung = client(time, { DATABASE_POOLER: 'session' })
      .query(sql`select 1`)
      .catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + POOLER_WAIT_MS + SWEEP_INTERVAL_MS);
    await settled();

    expect(((await hung) as DbError).code).toBe('X_DB_UNAVAILABLE');
  });

  test('the budget is an option, and PgBouncer default query_wait_timeout is its default', async () => {
    expect(POOLER_WAIT_MS).toBe(120_000);
    const time = manualTime();
    installPools();
    const hung = client(time, { DATABASE_POOLER: 'transaction' }, 3_000)
      .query(sql`select 1`)
      .catch((error: unknown) => error);
    time.until(1_000 + UNANSWERED_GRACE_MS + 3_000 + SWEEP_INTERVAL_MS);
    await settled();

    expect(((await hung) as DbError).code).toBe('X_DB_UNAVAILABLE');
  });

  test('a budget that is not a whole number is refused at construction', () => {
    expect(() => client(manualTime(), { DATABASE_POOLER: 'transaction' }, Number.NaN)).toThrow(
      'poolerWaitMs',
    );
  });
});
