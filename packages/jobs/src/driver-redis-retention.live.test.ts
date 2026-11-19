// What the Redis driver keeps once a row has ended, against a real server: every key it leaves
// behind carries an expiry, so a box up for a month holds one retention window of history, never
// every job it ever ran — the window pg's `jobs-retention.ts` sweeps. Skips unless `TEST_REDIS_URL`.

import { afterAll, describe, expect, test } from 'bun:test';
import { frozenClock, JOBS_DEAD_RETENTION_MS_DEFAULT } from '@ultimat3/core';
import { JOB_EXPIRED } from './driver';
import { redisJobDriver } from './driver-redis';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const root = `xlive-retention-${crypto.randomUUID()}`;

describe.skipIf(url === '')('live · redis · what an ended row leaves behind', () => {
  const client = url === '' ? undefined : new Bun.RedisClient(url);
  const send = async (command: string, args: string[]): Promise<unknown> =>
    client === undefined ? undefined : await client.send(command, args);
  let runs = 0;
  const fresh = () => {
    runs += 1;
    return `${root}-${runs}`;
  };

  afterAll(async () => {
    const found = await send('KEYS', [`{${root}*`]);
    for (const key of Array.isArray(found) ? found : []) await send('DEL', [String(key)]);
    client?.close();
  });

  /** Every key under a namespace with no expiry, minus the ones that are bounded by design. */
  async function unbounded(prefix: string): Promise<string[]> {
    const found = await send('KEYS', [`{${prefix}}:*`]);
    const kept: string[] = [];
    for (const key of Array.isArray(found) ? found.map(String) : []) {
      // One member per queue NAME and one per live key: neither grows with jobs run.
      if (key.endsWith(':queues') || key.endsWith(':idem')) continue;
      if (Number(await send('PTTL', [key])) === -1) kept.push(key);
    }
    return kept;
  }

  test('a debounced key leaves nothing in :debounce once its row has expired', async () => {
    const prefix = fresh();
    const driver = redisJobDriver({ prefix, doneTtlMs: 60_000, ...(client ? { client } : {}) });
    for (let index = 0; index < 5; index += 1) {
      const queued = await driver.enqueue({
        name: 'debounced.job',
        queue: 'q',
        input: { index },
        idempotencyKey: `reindex:${index}`,
        maxAttempts: 1,
        onConflict: 'replace',
      });
      const [claimed] = await driver.claim({
        queues: ['q'],
        limit: 1,
        visibilityTimeoutMs: 60_000,
        workerId: 'w',
      });
      expect(claimed?.id).toBe(queued.id);
      await driver.ack(queued.id, { workerId: 'w', claim: claimed?.claim ?? 0 });
    }
    // The fence outlives the run exactly as long as the row does: a key with no expiry is one
    // field per distinct key ever debounced, for the life of the server.
    expect(Number(await send('HLEN', [`{${prefix}}:debounce`]))).toBe(0);
    expect(await unbounded(prefix)).toEqual([]);
  });

  test('a fence written to the old :debounce hash still fences, and leaves with its row', async () => {
    for (const doneTtlMs of [60_000, 0]) {
      const prefix = fresh();
      const driver = redisJobDriver({ prefix, doneTtlMs, ...(client ? { client } : {}) });
      const request = {
        name: 'debounced.job',
        queue: 'q',
        input: {},
        idempotencyKey: 'doc-1',
        maxAttempts: 1,
        onConflict: 'replace' as const,
      };
      const newer = '00000000-0000-7000-8000-000000000002';
      await driver.enqueue({ ...request, id: newer });
      // The layout a server written by an earlier release holds: the fence as a HASH field.
      const field = JSON.stringify([request.name, '', request.idempotencyKey]);
      await send('DEL', [`{${prefix}}:debounce:${field}`]);
      await send('HSET', [`{${prefix}}:debounce`, field, newer]);
      const [row] = await driver.claim({
        queues: ['q'],
        limit: 1,
        visibilityTimeoutMs: 60_000,
        workerId: 'w',
      });
      await driver.ack(newer, { workerId: 'w', claim: row?.claim ?? 0 });

      const older = '00000000-0000-7000-8000-000000000001';
      const stale = await driver.enqueue({ ...request, id: older });
      expect(stale).toMatchObject({ id: newer, deduped: true });
      const moved = Number(await send('HLEN', [`{${prefix}}:debounce`])) === 0;
      expect(moved).toBe(doneTtlMs > 0);
    }
  });

  test('an expired, never-run job is gone after the dead retention window', async () => {
    const prefix = fresh();
    const clock = frozenClock('2026-11-12T00:00:00.000Z');
    const driver = redisJobDriver({
      prefix,
      clock,
      deadTtlMs: 60_000,
      ...(client ? { client } : {}),
    });
    const queued = await driver.enqueue({
      name: 'notify.job',
      queue: 'q',
      input: {},
      idempotencyKey: 'n',
      maxAttempts: 3,
      expiresAt: clock.now().getTime() + 1_000,
    });
    clock.advance(2_000);
    const buried: string[] = [];
    const claimed = await driver.claim({
      queues: ['q'],
      limit: 1,
      visibilityTimeoutMs: 60_000,
      workerId: 'w',
      onExhausted: (rows) => buried.push(...rows.map((row) => `${row.id}:${row.lastError}`)),
    });
    expect(claimed).toEqual([]);
    expect(buried).toEqual([`${queued.id}:${JOB_EXPIRED}`]);
    const ttl = Number(await send('PTTL', [`{${prefix}}:job:${queued.id}`]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await unbounded(prefix)).toEqual([`{${prefix}}:failed:q`]);

    // The zset member goes once its window has passed: the next burial into the set trims it.
    clock.advance(61_000);
    const next = await driver.enqueue({
      name: 'notify.job',
      queue: 'q',
      input: {},
      idempotencyKey: 'n2',
      maxAttempts: 3,
      expiresAt: clock.now().getTime() + 1_000,
    });
    clock.advance(2_000);
    await driver.claim({ queues: ['q'], limit: 1, visibilityTimeoutMs: 60_000, workerId: 'w' });
    expect(await send('ZRANGE', [`{${prefix}}:failed:q`, '0', '-1'])).toEqual([next.id]);
  });

  test('a dead row is kept for the dead window by default, and forever with deadTtlMs: 0', async () => {
    const ttlOf = async (deadTtlMs?: number): Promise<number> => {
      const prefix = fresh();
      const driver = redisJobDriver({
        prefix,
        ...(deadTtlMs === undefined ? {} : { deadTtlMs }),
        ...(client ? { client } : {}),
      });
      const queued = await driver.enqueue({
        name: 'dead.job',
        queue: 'q',
        input: {},
        idempotencyKey: 'd',
        maxAttempts: 1,
      });
      const [row] = await driver.claim({
        queues: ['q'],
        limit: 1,
        visibilityTimeoutMs: 60_000,
        workerId: 'w',
      });
      const by = { workerId: 'w', claim: row?.claim ?? 0 };
      await driver.nack(queued.id, { ...by, delayMs: 0, deadLetter: true });
      return Number(await send('PTTL', [`{${prefix}}:job:${queued.id}`]));
    };
    const kept = await ttlOf();
    expect(kept).toBeGreaterThan(JOBS_DEAD_RETENTION_MS_DEFAULT - 60_000);
    expect(kept).toBeLessThanOrEqual(JOBS_DEAD_RETENTION_MS_DEFAULT);
    expect(await ttlOf(0)).toBe(-1);
  });
});
