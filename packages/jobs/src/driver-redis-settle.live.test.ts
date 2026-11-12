// The Redis driver's `onSettled` re-drive take against a real server, past one page of debts it
// must leave: another deploy's, and ones inside their own job's longer grace. A take that read
// only the oldest thousand ids and skipped them all handed out nothing, every pass, for good.
// Skips unless `TEST_REDIS_URL`.

import { afterAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { redisJobDriver } from './driver-redis';
import { REDIS_SETTLE_SCAN } from './driver-redis-settle';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const prefix = `xlive-settle-${crypto.randomUUID()}`;
const client = url === '' ? undefined : new Bun.RedisClient(url);

/** `count` rows of `name`, each acked owing its hook — the debts a crash after the ack leaves. */
async function owe(driver: JobDriver, name: string, count: number): Promise<string[]> {
  const queue = `q-${name}`;
  await driver.enqueueMany(
    Array.from({ length: count }, (_, n) => ({
      name,
      queue,
      input: {},
      idempotencyKey: `${name}:${n}`,
      maxAttempts: 1,
    })),
  );
  const claimed = await driver.claim({
    queues: [queue],
    limit: count,
    visibilityTimeoutMs: 60_000,
    workerId: 'w',
  });
  for (const row of claimed) {
    await driver.ack(row.id, { workerId: 'w', claim: row.claim, owesSettle: true });
  }
  return claimed.map((row) => row.id);
}

describe.skipIf(url === '')('the redis onSettled take, past a page of debts it leaves', () => {
  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`{${prefix}}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  test('a lost debt behind more than a page of left ones is still taken', async () => {
    const clock = frozenClock('2026-11-12T00:00:00.000Z');
    const driver = redisJobDriver({ prefix, clock, ...(client === undefined ? {} : { client }) });
    const debt = driver.settleDebt;
    if (debt === undefined) return expect.unreachable('the redis driver records no debt');
    const left = Math.ceil(REDIS_SETTLE_SCAN * 0.6);
    // The oldest: no hook in this deploy, and a hook whose grace is nowhere near over.
    await owe(driver, 'other-deploy', left);
    await owe(driver, 'young', left);
    clock.advance(10);
    const lost = await owe(driver, 'lost', 1);
    clock.advance(2_000);
    const jobs = [
      { name: 'lost', graceMs: 1_000 },
      { name: 'young', graceMs: 3_600_000 },
    ];
    const taken = await debt.takeLost(jobs, 50);
    expect(taken.map((row) => row.id)).toEqual(lost);
    // Another deploy's debts are left owed, for the leader that declares their hook.
    clock.advance(1);
    const theirs = await debt.takeLost([{ name: 'other-deploy', graceMs: 0 }], 2 * left);
    expect(theirs).toHaveLength(left);
  });
});
