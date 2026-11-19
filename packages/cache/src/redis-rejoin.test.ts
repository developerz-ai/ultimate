// What a bust puts BACK when the store refuses to delete values: batched and bounded on the wire,
// re-leased so a re-created bucket cannot outlive its values, and only into the buckets the
// member really was in — a collection bust never reads its collection-tag bucket.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { RedisLike } from './redis';
import { REDIS_TAG_LEASE_SCRIPT, TAG_GRACE_MS } from './redis-buckets';
import { fakeRedis, tierFor } from './redis-fake-fixture';
import { tag } from './tags';

const rejoins = (sent: readonly string[][]): string[][] =>
  sent.filter((entry) => entry[0] === 'ZADD' && entry[2] === 'GT');

describe('a refused delete is re-joined', () => {
  test('in batches, with a bounded number of commands in flight', async () => {
    const server = fakeRedis();
    let inFlight = 0;
    let peak = 0;
    const slow: RedisLike = {
      get: (key) => server.get(key),
      set: (key, value) => server.set(key, value),
      async send(command, args) {
        const rejoin = command === 'ZADD' && args[1] === 'GT';
        if (rejoin) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
        }
        await new Promise((turn) => setTimeout(turn, 0));
        if (rejoin) inFlight -= 1;
        return await server.send(command, args);
      },
    };
    const MEMBERS = 2_500;
    const tier = tierFor(server);
    for (let at = 0; at < MEMBERS; at += 1) {
      await tier.set(`k${at}`, at, { ttlMs: 60_000, tags: [tag('post', '1')] });
      server.refuseDel(`x:c:k${at}`);
    }
    server.sent.length = 0;

    await expect(tierFor(slow).invalidateTags([tag('post', '1')])).rejects.toThrow(
      'redis refused UNLINK',
    );

    // Two buckets get members back (the row's and the entity index), 1,000 members per command.
    expect(rejoins(server.sent)).toHaveLength(2 * Math.ceil(MEMBERS / 1_000));
    expect(peak).toBeLessThanOrEqual(8);
    expect(server.members('x:t2:{post}:1')).toHaveLength(MEMBERS);
    expect(server.members('x:e2:{post}')).toHaveLength(MEMBERS);
  });

  test('every bucket it re-joins into is leased again, so one it re-created is never immortal', async () => {
    const server = fakeRedis();
    const now = 1_700_000_000_000;
    const clock = frozenClock(now);
    const tier = tierFor(server, { clock });
    await tier.set('stuck', 'v', { ttlMs: 60_000, tags: [tag('post', '1')] });
    server.refuseDel('x:c:stuck');
    clock.advance(10_000);
    server.sent.length = 0;

    await expect(tier.invalidateTags([tag('post', '1')])).rejects.toThrow('redis refused UNLINK');

    const wire = server.sent;
    for (const bucket of ['x:t2:{post}:1', 'x:e2:{post}']) {
      const added = wire.findIndex((entry) => rejoins([entry]).length === 1 && entry[1] === bucket);
      expect(added).toBeGreaterThan(-1);
      // The member's score less the clock now: 50s of value + the grace, never a lease of none.
      const lease = String(Math.ceil((60_000 - 10_000 + TAG_GRACE_MS) / 1_000));
      expect(wire.slice(added).filter((entry) => entry[0] === 'EVAL')).toContainEqual([
        'EVAL',
        REDIS_TAG_LEASE_SCRIPT,
        '1',
        bucket,
        lease,
      ]);
    }
  });

  test('a collection bust puts back into the collection-tag bucket only what was in it', async () => {
    const server = fakeRedis();
    const tier = tierFor(server);
    await tier.set('row', 'r', { ttlMs: 60_000, tags: [tag('post', '1')] });
    await tier.set('list', 'l', { ttlMs: 60_000, tags: [tag('post')] });
    server.refuseDel('x:c:row');
    server.refuseDel('x:c:list');

    await expect(tier.invalidateTags([tag('post')])).rejects.toThrow('redis refused UNLINK');

    // `row` was never in `x:t2:{post}`: put there, every later bust of ANY post row evicts it.
    expect(server.members('x:t2:{post}')).toEqual(['x:c:list']);
    expect(server.members('x:e2:{post}').toSorted()).toEqual(['x:c:list', 'x:c:row']);
    server.sent.length = 0;
    await tier.invalidateTags([tag('post', '2')]).catch(() => undefined);
    expect(server.sent.filter((entry) => entry[0] === 'UNLINK')).toEqual([['UNLINK', 'x:c:list']]);
  });
});
