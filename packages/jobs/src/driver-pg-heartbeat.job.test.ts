// A lease renewal against a real Postgres (the embedded one): it must be a HOT update, writing no
// index. A running job renews every few seconds for its whole life, so a renewal that touches an
// indexed column rewrites every matching index each time — 247,180 updates, 8 HOT in production.
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';

/** The embedded boot alone is tens of seconds (`driver-pg-lifecycle.job.test.ts`). */
setDefaultTimeout(120_000);

afterAll(async () => {
  await (await embeddedPg()).close();
});

/** `count` running rows written in one statement, so they pack the heap at its fillfactor. */
const RUNNING = `
insert into x_jobs (id, name, input, idempotency_key, run_id, attempt, state, visible_at,
                    claimed_by, claims, updated_at)
select gen_random_uuid(), 'mail.send', '{"to":"someone@example.test","body":"a rendered body"}',
       'hb:' || g, gen_random_uuid(), 1, 'running', now() + interval '30 seconds', 'w1', 1,
       now() - interval '1 hour'
  from generate_series(1, $1::int) as g
returning id
`;

interface Updates {
  readonly all: number;
  readonly hot: number;
}

async function updates(): Promise<Updates> {
  const { executor } = await embeddedPg();
  // The cumulative counters reach the view when the backend flushes them, not per statement.
  await executor.query('select pg_stat_force_next_flush()', []);
  const rows = await executor.query<{ upd: number | string; hot: number | string }>(
    `select n_tup_upd as upd, n_tup_hot_upd as hot from pg_stat_user_tables where relname = 'x_jobs'`,
    [],
  );
  return { all: Number(rows[0]?.upd ?? 0), hot: Number(rows[0]?.hot ?? 0) };
}

describe('pg · a lease renewal', () => {
  test('x_jobs leaves a fifth of each page free, for the new row version', async () => {
    const { executor } = await embeddedPg();
    const rows = await executor.query<{ options: string[] | null }>(
      `select reloptions as options from pg_class where relname = 'x_jobs'`,
      [],
    );
    expect(rows[0]?.options).toEqual(['fillfactor=80']);
  });

  test('renewing every running row of packed pages is HOT, and moves no updated_at', async () => {
    const { executor } = await embeddedPg();
    await executor.query('truncate x_jobs', []);
    const ids = (await executor.query<{ id: string }>(RUNNING, [400])).map((row) => row.id);
    const driver = postgresJobDriver({ executor });
    const before = await updates();
    for (const id of ids) {
      expect(await driver.heartbeat(id, { visibilityTimeoutMs: 30_000, workerId: 'w1' })).toBe(
        true,
      );
    }
    const after = await updates();
    const all = after.all - before.all;
    expect(all).toBe(ids.length);
    // Above the plan's 0.5: every page has room for its rows' next version.
    expect((after.hot - before.hot) / all).toBeGreaterThan(0.9);
    const moved = await executor.query<{ n: number | string }>(
      `select count(*) as n from x_jobs where updated_at > now() - interval '1 minute'`,
      [],
    );
    expect(Number(moved[0]?.n)).toBe(0);
  });
});
