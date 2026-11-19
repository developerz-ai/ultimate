// The memory store's settle inside a MEMORY transaction, as inside a SQL one: settled BY the
// commit, so a rollback leaves the record in flight rather than replaying a success for rows the
// memory store never kept. A scope that has already ended is no transaction — the settle is its own.

import { describe, expect, test } from 'bun:test';
import { memoryTransactor } from '@ultimat3/entity';
import { memoryIdempotencyStore } from './idempotency-memory';

const KEY = '["chargeCard","user","u1",null,"k1"]';
const ROLL_BACK = new TypeError('roll it back');

const statusOf = async (store: ReturnType<typeof memoryIdempotencyStore>) =>
  (await store.get(KEY))?.status;

describe('a memory store settle inside a memory transaction', () => {
  test('a settle inside a rolled-back memory transaction leaves the record in flight', async () => {
    const store = memoryIdempotencyStore();
    const thrown = await memoryTransactor()
      .run(async () => {
        const { record } = await store.reserve(KEY, 'h');
        await store.settle(KEY, { charged: 'ch_1' }, record.id, false);
        throw ROLL_BACK;
      })
      .catch((error: unknown) => error);
    expect(thrown).toBe(ROLL_BACK);
    expect(await statusOf(store)).toBe('in-flight');
  });

  test('a settle inside a committed memory transaction lands with the commit', async () => {
    const store = memoryIdempotencyStore();
    let during: string | undefined;
    await memoryTransactor().run(async () => {
      const { record } = await store.reserve(KEY, 'h');
      await store.settle(KEY, { charged: 'ch_1' }, record.id, false);
      during = await statusOf(store);
    });
    expect(during).toBe('in-flight');
    expect(await statusOf(store)).toBe('settled');
  });

  test('a settle on a scope that already ended settles as its own unit of work', async () => {
    const store = memoryIdempotencyStore();
    let late: Promise<void> | undefined;
    await memoryTransactor().run(async () => {
      const { record } = await store.reserve(KEY, 'h');
      // Not awaited inside: it runs after the root committed, still on the scope's async chain.
      late = Promise.resolve().then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await store.settle(KEY, { charged: 'ch_1' }, record.id, false);
      });
    });
    await late;
    expect(await statusOf(store)).toBe('settled');
  });
});
