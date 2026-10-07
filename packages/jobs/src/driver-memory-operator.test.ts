// The memory operator where it must answer exactly as the pg statement does, and a shared
// scenario cannot reach cheaply: a bulk verb's row bound applies AFTER the verb's own predicate.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { MAX_BULK_ROWS } from './introspection';
import { operatorOf } from './operator-surface-fixture';

describe('unit · the memory operator', () => {
  test('promoteMany bounds the rows still waiting, never the rows already due', async () => {
    const clock = frozenClock('2026-10-01T00:00:00.000Z');
    const driver = memoryJobDriver({ clock });
    const enqueue = (key: string, runAt: number) =>
      driver.enqueue({
        name: 'promote.bound',
        queue: 'default',
        input: {},
        idempotencyKey: key,
        maxAttempts: 1,
        runAt,
      });
    // A full bound of delayed rows that came due on their own, and one, created last, still waiting:
    // `SQL_JOB_PROMOTE_MANY` reads `run_at > now()` BEFORE `limit`, so it promotes that one.
    const start = clock.now().getTime();
    for (let index = 0; index < MAX_BULK_ROWS; index += 1) await enqueue(`due-${index}`, start + 1);
    clock.advance(10);
    const waiting = await enqueue('waiting', start + 3_600_000);

    const operator = operatorOf(driver);
    expect(await operator.promoteMany({ state: 'delayed' })).toEqual({
      affected: 1,
      remaining: 0,
    });
    expect((await operator.job(waiting.id))?.state).toBe('ready');
  });
});
