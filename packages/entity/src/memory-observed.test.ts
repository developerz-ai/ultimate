// The memory driver reports through `@ultimat3/db`'s statement seam, so a loop in a unit test is
// the same verdict on memory as on Postgres. One event per repository operation, under the pair
// `pg-driver-attribution.test.ts` pins for the Postgres driver; no SQL is sent, so none is named.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { DbStatementEvent } from '@ultimat3/core';
import { ctxOf, resetInstrumentation, runWithContext, subscribe } from '@ultimat3/core';
import { expectedQueryLoop, statementFingerprint, statementKind } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';

const notes = entity('notes', {
  columns: { id: uuid().primaryKey(), title: text({ max: 50 }), hits: integer().default(0) },
});
const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const watching = (): DbStatementEvent[] => {
  const seen: DbStatementEvent[] = [];
  subscribe('db.statement', (event) => void seen.push(event.payload));
  return seen;
};

afterEach(() => {
  resetInstrumentation();
});

afterAll(() => {
  clearRegistry();
});

describe('unit · memoryRepo reports one attributed event per operation', () => {
  test('every operation is named as postgresRepo names it, read or write', async () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    await repo.insert({ id: ID, title: 'a', hits: 0 });
    await repo.insertAll([{ id: OTHER, title: 'b', hits: 0 }]);
    await repo.upsertAll([{ id: OTHER, title: 'c', hits: 0 }], { onConflict: ['id'] });
    await repo.findById(ID);
    await repo.findMany();
    await repo.count();
    await repo.countBy('title');
    await repo.aggregate('sum', 'hits');
    await repo.approximateCount();
    await repo.update(ID, { title: 'd' });
    await repo.updateWhere({ title: 'd' }, { title: 'e' });
    await repo.delete(ID);
    await repo.deleteWhere({ title: 'c' });

    expect(seen.map(statementFingerprint)).toEqual([
      'notes.insert',
      'notes.insertAll',
      'notes.upsertAll',
      'notes.findById',
      'notes.findMany',
      'notes.count',
      'notes.countBy',
      'notes.sum',
      'notes.approximateCount',
      'notes.update',
      'notes.updateWhere',
      'notes.delete',
      'notes.deleteWhere',
    ]);
    expect(seen.map((event) => statementKind(event.text))).toEqual([
      'write',
      'write',
      'write',
      'read',
      'read',
      'read',
      'read',
      'read',
      'read',
      'write',
      'write',
      'write',
      'write',
    ]);
  });

  test('rows answers what a read returned and what a write touched, and no value is carried', async () => {
    const repo = memoryRepo(notes);
    await repo.insertAll([
      { id: ID, title: 'a', hits: 0 },
      { id: OTHER, title: 'a', hits: 0 },
    ]);
    const seen = watching();
    await repo.findMany();
    await repo.findById(ID);
    await repo.findById('00000000-0000-4000-8000-000000000003');
    await repo.updateWhere({ title: 'a' }, { title: 'b' });
    expect(seen.map((event) => event.rows)).toEqual([2, 1, 0, 2]);
    expect(seen.every((event) => event.values.length === 0)).toBe(true);
  });

  test('a refused write is still a statement, and the refusal is what the caller gets', async () => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: ID, title: 'a', hits: 0 });
    const seen = watching();
    const refused = await repo
      .insert({ id: ID, title: 'b', hits: 0 })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'X_DB_UNIQUE_VIOLATION' });
    expect(seen.map((event) => [statementFingerprint(event), event.rows])).toEqual([
      ['notes.insert', 0],
    ]);
    expect(seen[0]?.error).toBe(refused);
  });

  // The bus contains a subscriber's throw: an observer can never fail the call it observes.
  test('a throwing subscriber never rejects the call that sent the statement', async () => {
    const repo = memoryRepo(notes);
    const verdict = new RangeError('the subscriber decided');
    subscribe('db.statement', () => {
      throw verdict;
    });
    expect(await repo.count()).toBe(0);
  });

  test('the expected-loop reason rides on the event', async () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    await expectedQueryLoop('one lookup per field', () => repo.count());
    await repo.count();
    expect(seen.map((event) => event.expected)).toEqual(['one lookup per field', undefined]);
  });

  test('a lock is one statement, reported before the body it guards runs', async () => {
    const repo = memoryRepo(notes);
    await repo.insert({ id: ID, title: 'a', hits: 0 });
    const seen = watching();
    await repo.lock?.(ID, async () => {
      await repo.count();
    });
    expect(seen.map(statementFingerprint)).toEqual(['notes.lock', 'notes.count']);
  });

  test('reset() is no statement', () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    repo.reset();
    expect(seen).toEqual([]);
  });
});

describe('unit · point lookups in one microtask of one request are one statement, as coalesce.ts', () => {
  const ids = [ID, OTHER, ID, OTHER, ID, OTHER, ID, OTHER];

  test('in a request, a Promise.all of lookups is one event', async () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    await runWithContext(ctxOf({}), () => Promise.all(ids.map((id) => repo.findById(id))));
    expect(seen.map(statementFingerprint)).toEqual(['notes.findById']);
  });

  test('in a request, an awaited loop is one event per lookup', async () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    await runWithContext(ctxOf({}), async () => {
      for (const id of ids) await repo.findById(id);
    });
    expect(seen.length).toBe(ids.length);
  });

  test('outside a request nothing coalesces: postgresRepo declines there too', async () => {
    const repo = memoryRepo(notes);
    const seen = watching();
    await Promise.all(ids.map((id) => repo.findById(id)));
    expect(seen.length).toBe(ids.length);
  });
});
