// Single responsibility: a memory transaction is ambient — a write inside it that names no `tx` is
// undone when it rolls back, whichever door it came through — and a commit keeps every write.
import { afterAll, describe, expect, test } from 'bun:test';
import { text } from './columns';
import { entity } from './entity';
import { memoryJournal } from './memory-journal';
import { memoryRepo, memoryTransactor } from './memory-repo';
import { clearRegistry } from './registry';
import type { Tx } from './repo';

afterAll(() => {
  clearRegistry();
});

const notes = entity('mj_notes', { columns: { id: text().primaryKey(), body: text() } });

interface Listed {
  findMany(args: object): Promise<{ readonly rows: readonly { id: string; body: string }[] }>;
}

const ids = async (repo: Listed): Promise<string[]> =>
  (await repo.findMany({})).rows.map((row) => `${row.id}:${row.body}`).sort();

class Rollback extends TypeError {}

/** `Tx.onCommit` is optional on the contract; the memory transactor always carries it. */
const afterCommit = (tx: Tx, effect: () => void): void => {
  if (tx.onCommit === undefined) expect.unreachable('a memory Tx with no onCommit');
  tx.onCommit(effect);
};

/** `work` in a memory transaction that always rolls back, as `inRolledBackScope` opens one. */
const rolledBack = async (work: () => Promise<void>): Promise<unknown> =>
  memoryTransactor()
    .run(async () => {
      await work();
      throw new Rollback('rollback');
    })
    .catch((error: unknown) => error);

describe('an ambient memory transaction', () => {
  test('a bare insert, update, delete and batch with no tx are all undone on rollback', async () => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: 'kept', body: 'before' });
    await repo.insert({ id: 'gone', body: 'before' });
    const ended = await rolledBack(async () => {
      await repo.insert({ id: 'new', body: 'x' });
      await repo.update('kept', { body: 'after' });
      await repo.delete('gone');
      await repo.upsertAll([{ id: 'upserted', body: 'z' }], { onConflict: ['id'] });
      await repo.insertAll([{ id: 'batch', body: 'y' }]);
    });
    expect(ended).toBeInstanceOf(Rollback);
    expect(await ids(repo)).toEqual(['gone:before', 'kept:before']);
  });

  test('a nested transaction that COMMITS is a savepoint: its rows undone, its effects run', async () => {
    const repo = memoryRepo(notes);
    let effects = 0;
    await rolledBack(() =>
      memoryTransactor().run(async (tx) => {
        afterCommit(tx, () => {
          effects += 1;
        });
        await repo.insert({ id: 'committed', body: 'x' }, { tx });
        await repo.insertAll([{ id: 'batch', body: 'y' }]);
      }),
    );
    expect(await ids(repo)).toEqual([]);
    expect(effects).toBe(1);
  });

  test('a lock taken and released inside it does not stall the next write to that row', async () => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: 'locked', body: 'before' });
    await rolledBack(async () => {
      await repo.lock?.('locked', async (row, tx) => {
        await repo.update(row.id, { body: 'inside' }, { tx });
      });
      await repo.update('locked', { body: 'after' });
    });
    expect(await ids(repo)).toEqual(['locked:before']);
  });

  test('a commit keeps every write, named tx or not, and runs its effects', async () => {
    const repo = memoryRepo(notes);
    let effects = 0;
    await memoryTransactor().run(async (tx) => {
      afterCommit(tx, () => {
        effects += 1;
      });
      await repo.insert({ id: 'durable', body: 'x' }, { tx });
      await repo.insert({ id: 'bare', body: 'y' });
    });
    expect(await ids(repo)).toEqual(['bare:y', 'durable:x']);
    expect(effects).toBe(1);
  });

  test('outside one there is no ambient transaction', async () => {
    expect(memoryJournal()).toBeUndefined();
    await memoryTransactor().run(async (tx) => {
      expect(memoryJournal()).toBe(tx);
    });
    expect(memoryJournal()).toBeUndefined();
  });
});
