// Single responsibility: `onCommit` — work that must happen only once a transaction's writes are
// durable. The dev row observer reported a write the moment the repository made it, so a live
// query saw a row its transaction then rolled back.

import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { createRecordingClient } from './fake';
import { withTransaction } from './transaction';

beforeEach(() => {
  setDbClient(createRecordingClient());
});

describe('onCommit', () => {
  test('fires after COMMIT, in registration order, and not before', async () => {
    const fired: string[] = [];
    await withTransaction(async (tx) => {
      tx.onCommit(() => fired.push('a'));
      tx.onCommit(() => fired.push('b'));
      expect(fired).toEqual([]);
    });
    expect(fired).toEqual(['a', 'b']);
  });

  test('never fires when the transaction rolls back', async () => {
    const fired: string[] = [];
    await withTransaction(async (tx) => {
      tx.onCommit(() => fired.push('a'));
      throw new RangeError('the unit of work failed');
    }).catch(() => undefined);
    expect(fired).toEqual([]);
  });

  test('a nested scope that commits waits for the ROOT; one that rolls back is discarded', async () => {
    const fired: string[] = [];
    await withTransaction(async () => {
      await withTransaction(async (inner) => {
        inner.onCommit(() => fired.push('kept'));
      });
      await withTransaction(async (inner) => {
        inner.onCommit(() => fired.push('dropped'));
        throw new RangeError('savepoint rolled back');
      }).catch(() => undefined);
      expect(fired).toEqual([]);
    });
    expect(fired).toEqual(['kept']);
  });

  test('a throwing effect does not fail a transaction that already committed', async () => {
    const fired: string[] = [];
    const answer = await withTransaction(async (tx) => {
      tx.onCommit(() => {
        throw new RangeError('observer failed');
      });
      tx.onCommit(() => fired.push('still'));
      return 42;
    });
    expect(answer).toBe(42);
    expect(fired).toEqual(['still']);
  });

  test('a straggler registering after COMMIT runs at once; after ROLLBACK it is dropped', async () => {
    const fired: string[] = [];
    let late: ((effect: () => void) => void) | undefined;
    await withTransaction(async (tx) => {
      late = (effect) => tx.onCommit(effect);
    });
    late?.(() => fired.push('after-commit'));
    await withTransaction(async (tx) => {
      late = (effect) => tx.onCommit(effect);
      throw new RangeError('rolled back');
    }).catch(() => undefined);
    late?.(() => fired.push('after-rollback'));
    expect(fired).toEqual(['after-commit']);
  });
});
