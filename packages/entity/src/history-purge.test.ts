// A history table is append-only in both drivers; `purgingHistory(name, work)` is the one door out —
// a filtered delete of THAT table only, which a subject's erase needs on the memory driver too.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { purgingHistory } from './history-purge';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-0000000000e1';
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const posts = entity('hp_posts', {
  history: true,
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 40 }) },
});
const postsHistory = posts.$history ?? expect.unreachable('hp_posts declares history');
const other = entity('hp_notes', {
  history: true,
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), body: text({ max: 40 }) },
});

// A history row's tenant column is absent from its type: a read of it is scoped by the actor's org,
// never filtered by hand.
const inOrg = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'reader', orgId: ORG }) }), work);

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return 'resolved';
};

describe('memory · purging a history table', () => {
  const db = database({ posts, postsHistory, other }, { driver: memoryDriver() });
  const scope = { orgId: ORG };

  test('refused outside a purge, and inside one naming another table; let through when named', async () => {
    await db.posts.insert({ id: id(1), orgId: ORG, title: 'a' }, scope);
    await db.posts.update(id(1), { title: 'b' }, scope);
    await db.posts.insert({ id: id(2), orgId: ORG, title: 'c' }, scope);
    expect(await inOrg(() => db.postsHistory.count())).toBe(3);
    const erase = () => db.postsHistory.deleteWhere({ rowId: id(1) }, scope);
    expect(await codeOf(erase)).toBe('X_ENTITY_APPEND_ONLY');
    expect(await codeOf(() => purgingHistory(other.$name, erase))).toBe('X_ENTITY_APPEND_ONLY');
    // A purge scope never opens the history table to a rewrite, only to the delete.
    expect(
      await codeOf(() =>
        purgingHistory(postsHistory.$name, () =>
          db.postsHistory.updateWhere({ rowId: id(2) }, { rowId: id(9) }, scope),
        ),
      ),
    ).toBe('X_ENTITY_APPEND_ONLY');
    expect(await purgingHistory(postsHistory.$name, erase)).toBe(2);
    expect(await inOrg(() => db.postsHistory.count())).toBe(1);
  });

  test('the parent table is not opened by a purge of its history', async () => {
    const plain = entity('hp_ledger', {
      appendOnly: true,
      columns: { id: uuid().primaryKey(), amount: text() },
    });
    const ledgerDb = database({ plain }, { driver: memoryDriver() });
    await ledgerDb.plain.insert({ id: id(5), amount: '1' });
    expect(
      await codeOf(() =>
        purgingHistory(plain.$name, () => ledgerDb.plain.deleteWhere({ id: id(5) })),
      ),
    ).toBe('X_ENTITY_APPEND_ONLY');
  });
});
