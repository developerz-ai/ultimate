// The shared rate-limit store blackholed through the drills' own fault proxy: it must degrade to
// per-pod counting within its OWN deadline, not the pool's unanswered-statement bound. Reproduced
// by `pg-blackhole` on examples/dummy: a POST waited ~16 s for the limiter, then its own statement
// waited a second bound, and the two outran the 30 s HTTP deadline. Skips unless `TEST_DATABASE_URL`.

import { afterEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import { dbExecutor, postgresClient } from '@ultimat3/db';
import { postgresRateLimitStore, SQL_RATE_LIMIT_TABLE } from '@ultimat3/http';
import { type FaultProxy, faultProxy, faultTarget, throughFaultProxy } from './fault-proxy';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
/** The role's bound: the pool's sweep would answer a blackholed statement at 2,000 + 5,000 + 1 tick. */
const STATEMENT_MS = 2_000;
/** Well inside that sweep, well past the store's own deadline plus a loaded runner's slack. */
const PROMPT_MS = 1_500;
const CEILING_MS = 3_000;
const bucket = { capacity: 2, refillPerSecond: 0.001 };

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
  for (const statement of SQL_RATE_LIMIT_TABLE.split(';').filter((s) => s.trim() !== '')) {
    await client.query({ text: statement, values: [] });
  }
  const lines: string[] = [];
  const releaseLogSink = installLogSink((line) => {
    lines.push(line);
  });
  cleanups.push(() => {
    releaseLogSink();
  });
  const store = postgresRateLimitStore({ executor: dbExecutor(() => client) });
  return { proxy, store, lines, key: `blackhole:${crypto.randomUUID()}` };
}

/** `work`'s answer, or `'hung'` past the ceiling: a test that waits on a hang never reports it. */
async function within<T>(work: Promise<T>): Promise<T | 'hung'> {
  // real-clock: the blackholed socket and the store's deadline keep real time.
  const ceiling = Bun.sleep(CEILING_MS).then(() => 'hung' as const);
  return Promise.race([work, ceiling]);
}

describe.skipIf(adminUrl === '')(testName('live', 'the rate-limit store, blackholed'), () => {
  test('a take degrades to per-pod counting at its own deadline, not the pool bound', async () => {
    const { proxy, store, lines, key } = await setup();
    // Warm: the take answered by the real table, so the pool is open before the path goes dark.
    expect((await store.take(key, bucket, 1, 1_000)).allowed).toBe(true);
    await proxy.set({ kind: 'blackhole' });

    const started = performance.now();
    const first = await within(store.take(key, bucket, 1, 2_000));
    const elapsed = performance.now() - started;
    expect(first).not.toBe('hung');
    expect(elapsed).toBeLessThan(PROMPT_MS);
    expect(lines.some((line) => line.includes('http.rate_limit.degraded'))).toBe(true);
    expect(lines.some((line) => line.includes('X_RATE_LIMIT_STORE_TIMEOUT'))).toBe(true);

    // Degraded is still a limit: the per-pod bucket refuses past its capacity.
    const second = await within(store.take(key, bucket, 1, 2_000));
    const third = await within(store.take(key, bucket, 1, 2_000));
    expect([first, second, third].map((d) => (d === 'hung' ? d : d.allowed))).toEqual([
      true,
      true,
      false,
    ]);
    await proxy.set({ kind: 'pass' });
  }, 15_000);

  test('a peek degrades at the same deadline', async () => {
    const { proxy, store, lines, key } = await setup();
    await store.peek(key, bucket, 1_000);
    await proxy.set({ kind: 'blackhole' });

    const started = performance.now();
    const peeked = await within(store.peek(key, bucket, 2_000));
    expect(peeked).not.toBe('hung');
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    expect(lines.some((line) => line.includes('http.rate_limit.degraded'))).toBe(true);
    await proxy.set({ kind: 'pass' });
  }, 15_000);
});
