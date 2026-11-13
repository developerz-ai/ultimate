// Single responsibility: a pin's statements under the unanswered-statement bound. One past the bound
// in force on that connection retires the pool and leaves the pin dead; a bound the pin raised is
// honoured until its transaction ends; idle pins are a busy pool. Also: a pin's waits share one budget.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { postgresClient } from './client';
import type { DbError } from './errors';
import { recordingClient } from './fake';
import { setLocal } from './local-settings';
import { PIN_WORDS_MAX, pinWords } from './pin-statement';
import { boundSetBy, noteAnswered, pinBound, pinDeadlineMs } from './pool-pins';
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

describe('the bound a pin is judged by', () => {
  test("setLocal's own statement is the one read, so the two cannot drift apart", async () => {
    const recorder = recordingClient();
    await setLocal(recorder, { statement_timeout: '60000', 'x.tenant': 'org_1' });
    const [timeout, tenant] = recorder.statements;
    expect(timeout && boundSetBy(timeout)).toBe(60_000);
    expect(tenant && boundSetBy(tenant)).toBeUndefined();
  });

  test.each([
    ['set local statement_timeout = 2500', 2_500],
    ["SET statement_timeout TO '2s'", 2_000],
    ['set local statement_timeout = 0;', 0],
    ["set local statement_timeout = '1min'", 60_000],
    ['set local lock_timeout = 2500', undefined],
    ["set local statement_timeout = 'soon'", undefined],
    ["select set_config('statement_timeout', '20000', true)", 20_000],
    ["select set_config('lock_timeout', '20000', true)", undefined],
  ])('%s reads as %p', (text, ms) => {
    expect(boundSetBy({ text, values: [] })).toBe(ms);
  });

  test('a transaction end puts the role bound back; a savepoint rollback does not', () => {
    const pin = pinBound(1_000);
    noteAnswered(pin, { text: 'set local statement_timeout = 9000', values: [] }, 1_000);
    noteAnswered(pin, { text: 'ROLLBACK TO SAVEPOINT x_sp_1', values: [] }, 1_000);
    expect(pin.boundMs).toBe(9_000);
    noteAnswered(pin, { text: 'COMMIT', values: [] }, 1_000);
    expect(pin.boundMs).toBe(1_000);
    expect(pinDeadlineMs(pin, 5_000)).toBe(6_000);
    expect(pinDeadlineMs(pinBound(0), 5_000)).toBe(0);
  });
});

describe('a savepoint and a reset, on the bound a pin is judged by', () => {
  const note = (pin: ReturnType<typeof pinBound>, text: string): void =>
    noteAnswered(pin, { text, values: [] }, 1_000);

  test('a rollback to savepoint restores the bound the savepoint saw', () => {
    const pin = pinBound(1_000);
    note(pin, 'set local statement_timeout = 9000');
    note(pin, 'SAVEPOINT x_sp_1');
    note(pin, "select set_config('statement_timeout', '30000', true)");
    note(pin, 'SAVEPOINT x_sp_2');
    note(pin, 'set local statement_timeout = 60000');
    expect(pin.boundMs).toBe(60_000);

    // Back past both: the server undid both SETs, and `x_sp_1` itself is still open.
    note(pin, 'ROLLBACK TO SAVEPOINT x_sp_1');
    expect(pin.boundMs).toBe(9_000);
    note(pin, 'set local statement_timeout = 45000');
    note(pin, 'rollback to x_sp_1;');
    expect(pin.boundMs).toBe(9_000);
  });

  test('a released savepoint keeps what was set inside it, and a later rollback skips it', () => {
    const pin = pinBound(1_000);
    note(pin, 'SAVEPOINT x_sp_1');
    note(pin, 'SAVEPOINT x_sp_2');
    note(pin, 'set local statement_timeout = 7000');
    note(pin, 'RELEASE SAVEPOINT x_sp_2');
    expect(pin.boundMs).toBe(7_000);
    note(pin, 'ROLLBACK TO SAVEPOINT x_sp_1');
    expect(pin.boundMs).toBe(1_000);
  });

  test('a savepoint a rollback or a release destroyed restores nothing', () => {
    const pin = pinBound(1_000);
    note(pin, 'SAVEPOINT a');
    note(pin, 'set local statement_timeout = 2000');
    note(pin, 'SAVEPOINT b');
    note(pin, 'ROLLBACK TO SAVEPOINT a');
    note(pin, 'set local statement_timeout = 5000');
    note(pin, 'ROLLBACK TO SAVEPOINT b');
    expect(pin.boundMs).toBe(5_000);

    note(pin, 'SAVEPOINT c');
    note(pin, 'RELEASE SAVEPOINT c');
    note(pin, 'set local statement_timeout = 6000');
    note(pin, 'ROLLBACK TO SAVEPOINT c');
    expect(pin.boundMs).toBe(6_000);
  });

  test('a repeated name means the newest savepoint, as the server reads it', () => {
    const pin = pinBound(1_000);
    note(pin, 'SAVEPOINT s');
    note(pin, 'set local statement_timeout = 2000');
    note(pin, 'savepoint S');
    note(pin, 'set local statement_timeout = 3000');
    note(pin, 'ROLLBACK TO s');
    expect(pin.boundMs).toBe(2_000);
  });

  test('the transaction end forgets every savepoint', () => {
    const pin = pinBound(1_000);
    note(pin, 'SAVEPOINT x_sp_1');
    note(pin, 'set local statement_timeout = 7000');
    note(pin, 'COMMIT');
    note(pin, 'set local statement_timeout = 8000');
    // A name from the finished transaction restores nothing.
    note(pin, 'ROLLBACK TO SAVEPOINT x_sp_1');
    expect(pin.boundMs).toBe(8_000);
  });

  test.each([
    'RESET statement_timeout',
    'reset all;',
    'set local statement_timeout to default',
    'SET statement_timeout = DEFAULT',
  ])('%s puts the role bound back', (text) => {
    const pin = pinBound(1_000);
    note(pin, 'set local statement_timeout = 9000');
    note(pin, text);
    expect(pin.boundMs).toBe(1_000);
  });

  test('a reset of another setting leaves the bound alone', () => {
    const pin = pinBound(1_000);
    note(pin, 'set local statement_timeout = 9000');
    note(pin, 'RESET lock_timeout');
    expect(pin.boundMs).toBe(9_000);
  });
});

describe('statement text is library input: the recognisers read it in one pass', () => {
  // Each is a recognised statement's head, then 100k spaces, then a character that makes it no
  // statement at all — the shape that sends a backtracking `\s+…\s*$` pattern quadratic. Sized,
  // not timed: a quadratic read of these is ~10^10 steps and never finishes inside the test.
  const SPACES = ' '.repeat(100_000);
  test.each([
    'reset all',
    'reset statement_timeout',
    'savepoint a',
    'release savepoint a',
    'rollback to savepoint a',
    'commit',
    'set local statement_timeout = default',
    'set local statement_timeout = 5000',
    "select set_config('statement_timeout', '5000', true)",
  ])('%s, then 100k spaces and a stray word, moves nothing', (head) => {
    const pin = pinBound(1_000);
    noteAnswered(pin, { text: 'set local statement_timeout = 9000', values: [] }, 1_000);
    noteAnswered(pin, { text: `${head}${SPACES}x`, values: [] }, 1_000);
    noteAnswered(pin, { text: `${head}${SPACES};${SPACES}x`, values: [] }, 1_000);
    expect(pin.boundMs).toBe(9_000);
    expect(pin.savepoints).toHaveLength(0);
  });

  test('padding alone is still the statement: whitespace is read, never backtracked', () => {
    const pin = pinBound(1_000);
    noteAnswered(pin, { text: 'set local statement_timeout = 9000', values: [] }, 1_000);
    noteAnswered(pin, { text: `reset${SPACES}all${SPACES};${SPACES}`, values: [] }, 1_000);
    expect(pin.boundMs).toBe(1_000);
  });

  test('a tab or a newline separates words as a space does', () => {
    const pin = pinBound(1_000);
    noteAnswered(pin, { text: 'SAVEPOINT\tx_sp_1', values: [] }, 1_000);
    expect(pin.savepoints).toHaveLength(1);
    noteAnswered(pin, { text: 'set local\n  statement_timeout = 9000', values: [] }, 1_000);
    expect(pin.boundMs).toBe(9_000);
    noteAnswered(pin, { text: 'ROLLBACK TO\r\nSAVEPOINT x_sp_1', values: [] }, 1_000);
    expect(pin.boundMs).toBe(1_000);
  });

  test('a long statement stops being read after a dozen words', () => {
    const insert = `insert into t (a) values ${Array.from({ length: 10_000 }, () => '(1)').join(', ')}`;
    expect(pinWords(insert)).toBeUndefined();
    expect(pinWords('rollback work to savepoint "a b" ;')).toEqual([
      'rollback',
      'work',
      'to',
      'savepoint',
      '"a b"',
    ]);
    expect(pinWords(`${'w '.repeat(PIN_WORDS_MAX)}`)).toHaveLength(PIN_WORDS_MAX);
    expect(pinWords(`${'w '.repeat(PIN_WORDS_MAX + 1)}`)).toBeUndefined();
  });
});

describe('a statement on a pin nobody answers', () => {
  test('rejects at the bound, retires the pool, and the pin sends nothing more', async () => {
    // Reproduced by `x drill pg-blackhole`: a write inside a transaction ran ~30 s, answered by the
    // HTTP deadline's X_TIMEOUT, because a pin was only judged once pins filled the pool.
    const pools = installPools();
    const time = manualTime();
    const db = client(time);
    const pin = await db.reserve();
    const hung = pin.execute(sql`insert into t values (1)`).catch((error: unknown) => error);
    time.until(PAST_BOUND);

    const caught = (await hung) as DbError;
    expect(caught.code).toBe('X_DB_UNAVAILABLE');
    expect(caught.cause).toContain('insert into t');
    expect(pools[0]?.closes).toEqual([{ timeout: 1 }]);

    const rollback = (await pin.execute(sql`rollback`).catch((error: unknown) => error)) as DbError;
    expect(rollback.code).toBe('X_DB_UNAVAILABLE');
    expect(pools[0]?.sent).toEqual(['insert into t values (1)']);
    pin.release();

    const next = db.query(sql`select 'after'`);
    pools[1]?.answers.shift()?.([]);
    expect(await next).toEqual([]);
  });

  test('a bound the pin raised is the one it is judged by, until its transaction ends', async () => {
    const pools = installPools();
    const time = manualTime();
    const db = client(time);
    const pin = await db.reserve();
    const raising = pin.query(sql`select set_config(${'statement_timeout'}, ${'60000'}, true)`);
    pools[0]?.answers.shift()?.([]);
    await raising;

    const slow = pin.query(sql`select 'report'`).catch((error: unknown) => error);
    time.until(PAST_BOUND + 3 * SWEEP_INTERVAL_MS);
    await settled();
    expect(pools[0]?.closes).toEqual([]);
    pools[0]?.answers.shift()?.([{ ok: 1 }]);
    expect(await slow).toEqual([{ ok: 1 }]);

    const ending = pin.query(sql`commit`);
    pools[0]?.answers.shift()?.([]);
    await ending;
    const after = pin.query(sql`select 'next'`).catch((error: unknown) => error);
    time.until(2 * PAST_BOUND + 4 * SWEEP_INTERVAL_MS);
    expect(((await after) as DbError).code).toBe('X_DB_UNAVAILABLE');
    pin.release();
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
});

describe('reserve() on the pool that replaced a wedged one', () => {
  test('gets the whole budget there', async () => {
    let built = 0;
    host.Bun.SQL = class {
      readonly first = built++ === 0;
      unsafe(): Promise<unknown> {
        return new Promise(() => undefined);
      }
      reserve(): Promise<unknown> {
        const pin = { unsafe: this.unsafe.bind(this), release: () => undefined };
        // The new pool's queue is what the test reads the budget off.
        return this.first ? Promise.resolve(pin) : new Promise(() => undefined);
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
    await settled();

    const delays: number[] = [];
    // The budget left is read off `performance.now()`. Frozen, so a loaded host's milliseconds
    // between the reserve and its timer are not read as budget the new pool already spent (82 ms
    // of 100 was a red unit run, 2026-11-13): the replacement gets all of it, exactly.
    const clock = spyOn(performance, 'now').mockImplementation(() => 0);
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      const asked = db.reserve().catch((error: unknown) => error);
      await settled();
      expect(built).toBe(2);
      expect(delays).toEqual([100]);
      expect(((await asked) as DbError).code).toBe('X_DB_POOL_EXHAUSTED');
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
    for (const old of pins) old.release();
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
