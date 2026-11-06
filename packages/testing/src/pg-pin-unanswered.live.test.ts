// A write inside a transaction, blackholed mid-flight through the drills' own fault proxy: the
// unanswered-statement bound must fire on the transaction's pinned connection as it does on a pooled
// statement. Reproduced by `pg-blackhole`: a pinned write ran ~30 s, answered by the HTTP deadline's
// X_TIMEOUT. Skips unless `TEST_DATABASE_URL`.

import { afterEach, describe, expect, test } from 'bun:test';
import { type DbError, postgresClient, sql, withTransaction } from '@ultimat3/db';
import { type FaultProxy, faultProxy, faultTarget, throughFaultProxy } from './fault-proxy';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
const STATEMENT_MS = 300;
/** `UNANSWERED_GRACE_MS` and one sweep tick past the bound, plus a margin for a loaded runner. */
const BOUND_MS = STATEMENT_MS + 5_000;
const CEILING_MS = BOUND_MS + 2_500;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const proxy: FaultProxy = await faultProxy({ target: faultTarget(adminUrl) });
  cleanups.push(() => proxy.close());
  const client = postgresClient({
    url: throughFaultProxy(adminUrl, proxy.port),
    role: 'web',
    profile: { max: 4, statementTimeoutMs: STATEMENT_MS, drainTimeoutMs: 1_000 },
    env: {},
  });
  cleanups.push(() => client.close().catch(() => undefined));
  return { proxy, client };
}

/** `work`'s failure, or `'hung'` past the ceiling: a test that waits on a hang never reports it. */
async function within(work: Promise<unknown>): Promise<unknown> {
  // real-clock: the pool's sweep and the blackholed socket keep real time.
  const ceiling = Bun.sleep(CEILING_MS).then(() => 'hung' as const);
  return Promise.race([
    work.then(
      () => 'answered',
      (error: unknown) => error,
    ),
    ceiling,
  ]);
}

describe.skipIf(adminUrl === '')(testName('live', 'a pinned statement nobody answers'), () => {
  test('a transaction write blackholed mid-flight is X_DB_UNAVAILABLE near the bound, and the pool is replaced', async () => {
    const { proxy, client } = await setup();
    const started = { at: 0 };
    const writing = withTransaction(
      async (tx) => {
        await tx.execute(sql`create temp table x_pin_probe (n int) on commit drop`);
        await proxy.set({ kind: 'blackhole' });
        started.at = performance.now();
        await tx.execute(sql`insert into x_pin_probe values (1)`);
      },
      { client },
    );

    const outcome = await within(writing);
    const elapsed = performance.now() - started.at;
    expect(outcome).not.toBe('hung');
    expect((outcome as DbError).code).toBe('X_DB_UNAVAILABLE');
    expect((outcome as DbError).cause).toContain('insert into x_pin_probe');
    // The ROLLBACK that follows is never sent on the dead connection: one bound, not two.
    expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 1);
    expect(elapsed).toBeLessThan(CEILING_MS);

    const acceptedBefore = proxy.counts().accepted;
    await proxy.set({ kind: 'pass' });
    const rows = await client.query<{ ok: number }>(sql`select 5 as ok`);
    expect(rows[0]?.ok).toBe(5);
    expect(proxy.counts().accepted).toBeGreaterThan(acceptedBefore);
  }, 30_000);

  test('a pin whose own bound was raised keeps it: a slow answer inside that bound lands', async () => {
    const { proxy, client } = await setup();
    const answered = withTransaction(
      async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '20000', true)`);
        await proxy.set({ kind: 'delay', ms: BOUND_MS + 500 });
        return tx.one<{ ok: number }>(sql`select 6 as ok`);
      },
      { client },
    );
    // real-clock: the delayed answer is the proxy's real wait.
    expect((await answered)?.ok).toBe(6);
  }, 30_000);
});
