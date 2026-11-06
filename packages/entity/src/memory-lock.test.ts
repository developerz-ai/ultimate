// The memory driver's lock on its own: the queue, the reentrancy and the bound. The bound takes a
// parameter so this file does not wait out the 5 s every caller gets.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { MEMORY_LOCK_WAIT_MS, memoryLocks } from './memory-lock';
import { memoryTransactor } from './memory-transactor';

// A foreign failure handed to the subject: test input, never its verdict.
const CALLBACK_FAILED = new Error('the callback failed');
const INNER_CALLBACK_FAILED = new Error('the inner callback failed');
const ROOT_FAILED = new Error('the root failed');

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('unit · memoryLocks', () => {
  test('a key is a queue, first come first served', async () => {
    const locks = memoryLocks();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        locks.run('k', undefined, async () => {
          await tick();
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  test('two keys do not wait on each other', async () => {
    const locks = memoryLocks();
    const release = Promise.withResolvers<void>();
    const held = locks.run('a', undefined, () => release.promise);
    expect(await locks.run('b', undefined, async () => 'free')).toBe('free');
    release.resolve();
    await held;
  });

  test('two instances hold separate locks: one driver never blocks another', async () => {
    const release = Promise.withResolvers<void>();
    const held = memoryLocks().run('k', undefined, () => release.promise);
    expect(await memoryLocks().run('k', undefined, async () => 'free')).toBe('free');
    release.resolve();
    await held;
  });

  test('reentrant within one async chain', async () => {
    const locks = memoryLocks();
    const answer = await locks.run('k', undefined, () =>
      locks.run('k', undefined, async () => 'inner'),
    );
    expect(answer).toBe('inner');
  });

  test('a waiter past its bound is what a statement_timeout is, and the queue survives it', async () => {
    const locks = memoryLocks(5);
    const release = Promise.withResolvers<void>();
    const held = locks.run('k', undefined, () => release.promise);
    const waited = await locks
      .run('k', undefined, async () => 'ran')
      .catch((error: unknown) => error);
    if (!isUltimateError(waited)) expect.unreachable('the waiter gives up');
    expect(waited.code).toBe('X_DB_STATEMENT_TIMEOUT');
    release.resolve();
    await held;
    expect(await locks.run('k', undefined, async () => 'next')).toBe('next');
  });

  test('a sole waiter giving up leaves the holder holding: a newcomer still waits', async () => {
    const locks = memoryLocks(20);
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const holder = locks.run('k', undefined, async () => {
      await release.promise;
      order.push('holder done');
    });
    await locks.run('k', undefined, async () => undefined).catch(() => undefined);
    const newcomer = locks.run('k', undefined, async () => {
      order.push('newcomer ran');
    });
    await tick();
    release.resolve();
    await Promise.all([holder, newcomer]);
    expect(order).toEqual(['holder done', 'newcomer ran']);
  });

  test('every caller gets the five seconds the slice states', () => {
    expect(MEMORY_LOCK_WAIT_MS).toBe(5_000);
  });

  test('a throw frees the key', async () => {
    const locks = memoryLocks();
    await locks
      .run('k', undefined, async () => {
        throw CALLBACK_FAILED;
      })
      .catch(() => undefined);
    expect(await locks.run('k', undefined, async () => 'free')).toBe('free');
  });

  test('joined to a tx it is a savepoint: its own undo on a throw, the root’s on a rollback', async () => {
    const locks = memoryLocks();
    const undone: string[] = [];
    await memoryTransactor()
      .run(async (root) => {
        await locks
          .run('a', root, async (tx) => {
            tx.onRollback(() => undone.push('inner'));
            throw INNER_CALLBACK_FAILED;
          })
          .catch(() => undefined);
        expect(undone).toEqual(['inner']);
        await locks.run('b', root, async (tx) => {
          tx.onRollback(() => undone.push('kept'));
        });
        expect(undone).toEqual(['inner']);
        throw ROOT_FAILED;
      })
      .catch(() => undefined);
    expect(undone).toEqual(['inner', 'kept']);
  });

  test('joined to a tx the key is held to the root’s end, as a row lock is', async () => {
    const locks = memoryLocks();
    const order: string[] = [];
    const nested = Promise.withResolvers<void>();
    const end = Promise.withResolvers<void>();
    const root = memoryTransactor().run(async (tx) => {
      await locks.run('k', tx, async () => {
        order.push('nested');
      });
      nested.resolve();
      await end.promise;
      order.push('root ending');
    });
    await nested.promise;
    // Another caller, outside the root: it waits for the root, not for the scope that took the key.
    const second = locks.run('k', undefined, async () => {
      order.push('second');
    });
    await tick();
    end.resolve();
    await root;
    await second;
    expect(order).toEqual(['nested', 'root ending', 'second']);
  });

  test('a key taken in a savepoint is the root’s: the root writes it again with no wait', async () => {
    const locks = memoryLocks(5);
    await memoryTransactor().run(async () => {
      await memoryTransactor().run(() => locks.run('k', undefined, async () => undefined));
      expect(await locks.turn('k', undefined, () => 'free')).toBe('free');
      expect(await locks.run('k', undefined, async () => 'again')).toBe('again');
    });
  });

  test('the same tx may take its own key again after the scope that took it ended', async () => {
    const locks = memoryLocks(5);
    await memoryTransactor().run(async (root) => {
      await locks.run('k', root, async () => undefined);
      expect(await locks.run('k', root, async () => 'again')).toBe('again');
    });
  });
});
