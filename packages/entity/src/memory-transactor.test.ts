// Single responsibility: a memory transaction ends, as a Postgres one does. A write that outlives it
// is refused with the code a straggler on a finished `withTransaction` meets, an effect registered
// after COMMIT runs at once and one after ROLLBACK never, and a savepoint's effects wait for the root.
import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text } from './columns';
import { entity } from './entity';
import { memoryRepo, memoryTransactor } from './memory-repo';
import { clearRegistry } from './registry';
import type { Tx } from './repo';

afterAll(() => {
  clearRegistry();
});

const notes = entity('mt_notes', { columns: { id: text().primaryKey(), body: text() } });

class Rollback extends TypeError {}

const ids = async (repo: ReturnType<typeof memoryRepo<{ id: string; body: string }>>) =>
  (await repo.findMany({})).rows.map((row) => `${row.id}:${row.body}`).sort();

const codeOf = (error: unknown): string | undefined =>
  isUltimateError(error) ? error.code : undefined;

/** `Tx.onCommit` is optional on the contract; the memory transactor always carries it. */
const afterCommit = (tx: Tx, effect: () => void): void => {
  if (tx.onCommit === undefined) expect.unreachable('a memory Tx with no onCommit');
  tx.onCommit(effect);
};

describe('a write that outlives its memory transaction', () => {
  test('after a ROLLBACK it is refused, X_DB_TRANSACTION_CLOSED, and lands nowhere', async () => {
    const repo = memoryRepo(notes);
    const go = Promise.withResolvers<void>();
    let late: Promise<unknown> | undefined;
    await memoryTransactor()
      .run(async () => {
        // Not awaited: the straggler `setTimeout(() => repo.insert(b))` is, released below.
        late = go.promise.then(() => repo.insert({ id: 'late', body: 'x' }));
        throw new Rollback('rollback');
      })
      .catch(() => undefined);
    go.resolve();
    expect(codeOf(await late?.catch((error: unknown) => error))).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await ids(repo)).toEqual([]);
  });

  test('after a COMMIT it is refused too, update and delete alike: one rule', async () => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: 'kept', body: 'before' });
    const go = Promise.withResolvers<void>();
    const late: Promise<unknown>[] = [];
    await memoryTransactor().run(async () => {
      late.push(go.promise.then(() => repo.update('kept', { body: 'late' })));
      late.push(go.promise.then(() => repo.delete('kept')));
      late.push(go.promise.then(() => repo.deleteWhere({ id: 'kept' })));
      late.push(go.promise.then(() => repo.lock?.('kept', async () => undefined)));
    });
    go.resolve();
    const settled = await Promise.all(late.map((each) => each.catch((error: unknown) => error)));
    expect(settled.map(codeOf)).toEqual(Array(4).fill('X_DB_TRANSACTION_CLOSED'));
    expect(await ids(repo)).toEqual(['kept:before']);
  });

  test('a nested run opened after the root ended is refused before its work runs', async () => {
    const go = Promise.withResolvers<void>();
    let ran = false;
    let late: Promise<unknown> | undefined;
    await memoryTransactor().run(async () => {
      late = go.promise.then(() =>
        memoryTransactor().run(async () => {
          ran = true;
        }),
      );
    });
    go.resolve();
    expect(codeOf(await late?.catch((error: unknown) => error))).toBe('X_DB_TRANSACTION_CLOSED');
    expect(ran).toBe(false);
  });
});

describe('an effect registered late', () => {
  test('after COMMIT it runs at once; after ROLLBACK it never runs', async () => {
    let committed: Tx | undefined;
    let rolledBack: Tx | undefined;
    await memoryTransactor().run(async (tx) => {
      committed = tx;
    });
    await memoryTransactor()
      .run(async (tx) => {
        rolledBack = tx;
        throw new Rollback('rollback');
      })
      .catch(() => undefined);
    const ran: string[] = [];
    if (committed === undefined || rolledBack === undefined) expect.unreachable('no tx handed out');
    afterCommit(committed, () => ran.push('committed'));
    afterCommit(rolledBack, () => ran.push('rolled back'));
    expect(ran).toEqual(['committed']);
  });
});

describe('a nested memory transaction is a savepoint', () => {
  test('its effects wait for the root, and a root ROLLBACK drops them', async () => {
    const ran: string[] = [];
    await memoryTransactor()
      .run(async () => {
        await memoryTransactor().run(async (tx) => {
          afterCommit(tx, () => ran.push('nested'));
        });
        expect(ran).toEqual([]);
        throw new Rollback('rollback');
      })
      .catch(() => undefined);
    expect(ran).toEqual([]);
  });

  test('a root COMMIT runs them, after the root work', async () => {
    const ran: string[] = [];
    await memoryTransactor().run(async () => {
      await memoryTransactor().run(async (tx) => {
        afterCommit(tx, () => ran.push('nested'));
      });
      ran.push('root work');
    });
    expect(ran).toEqual(['root work', 'nested']);
  });

  test('a write on its handle after it released, root still open, is the root’s to undo', async () => {
    const repo = memoryRepo(notes);
    await memoryTransactor()
      .run(async () => {
        let inner: Tx | undefined;
        await memoryTransactor().run(async (tx) => {
          inner = tx;
        });
        if (inner === undefined) expect.unreachable('the nested run handed out no tx');
        await repo.insert({ id: 'via-released', body: 'x' }, { tx: inner });
        throw new Rollback('rollback');
      })
      .catch(() => undefined);
    expect(await ids(repo)).toEqual([]);
  });
});

describe('a savepoint that outlives its root', () => {
  const outlived = async (rollBack: boolean, via: 'lock' | 'nested run') => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: 'r', body: 'before' });
    const wrote = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    let late: Promise<unknown> | undefined;
    await memoryTransactor()
      .run(async () => {
        const body = async (tx?: Tx): Promise<void> => {
          await repo.update('r', { body: 'inside' }, tx === undefined ? {} : { tx });
          wrote.resolve();
          await go.promise;
        };
        late =
          via === 'lock'
            ? repo.lock?.('r', (_row, tx) => body(tx))
            : memoryTransactor().run(() => body());
        await wrote.promise;
        if (rollBack) throw new Rollback('rollback');
      })
      .catch(() => undefined);
    go.resolve();
    return { code: codeOf(await late?.catch((error: unknown) => error)), rows: await ids(repo) };
  };

  for (const via of ['lock', 'nested run'] as const) {
    test(`${via}: refused at its end; the rows it wrote before the root COMMITTED are kept`, async () => {
      expect(await outlived(false, via)).toEqual({
        code: 'X_DB_TRANSACTION_CLOSED',
        rows: ['r:inside'],
      });
    });

    test(`${via}: refused at its end; the rows it wrote are undone with the root’s ROLLBACK`, async () => {
      expect(await outlived(true, via)).toEqual({
        code: 'X_DB_TRANSACTION_CLOSED',
        rows: ['r:before'],
      });
    });
  }
});
