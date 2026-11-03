// Single responsibility: the memory driver's upsert refuses as one statement does, and a clean wide batch is not quadratic.
import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text } from './columns';
import { entity } from './entity';
import { undoingBatch } from './memory-batch';
import { memoryRepo, memoryTransactor } from './memory-repo';
import { clearRegistry } from './registry';
import type { Tx } from './repo';

// A foreign failure handed to the subject: test input, never its verdict.
const WORK_FAILED = new Error('the work failed');

afterAll(() => {
  clearRegistry();
});

const items = entity('mo_items', {
  columns: { id: text().primaryKey(), code: text().unique(), slug: text().unique() },
});
const plain = entity('mo_plain', { columns: { id: text().primaryKey(), label: text() } });

const codeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'resolved',
    (error: unknown) => (isUltimateError(error) ? error.code : String(error)),
  );

describe('memory upsertAll is all or nothing', () => {
  test('a row colliding on another unique undoes the rows before it', async () => {
    const repo = memoryRepo(items);
    await repo.insert({ id: 'x', code: 'x', slug: 'taken' });
    const rows = [
      { id: 'a', code: 'a', slug: 'a' },
      { id: 'b', code: 'b', slug: 'taken' },
    ];
    expect(await codeOf(repo.upsertAll(rows, { onConflict: ['code'] }))).toBe(
      'X_DB_UNIQUE_VIOLATION',
    );
    expect((await repo.findMany({})).rows.map((row) => row.id)).toEqual(['x']);
  });

  test('an update landed before the failure is undone too', async () => {
    const repo = memoryRepo(items);
    await repo.insertAll([
      { id: 'x', code: 'x', slug: 's1' },
      { id: 'y', code: 'y', slug: 's2' },
    ]);
    const rows = [
      { id: 'x', code: 'x', slug: 'moved' },
      { id: 'n', code: 'n', slug: 's2' },
    ];
    expect(await codeOf(repo.upsertAll(rows, { onConflict: ['code'] }))).toBe(
      'X_DB_UNIQUE_VIOLATION',
    );
    expect((await repo.findById('x'))?.slug).toBe('s1');
  });

  test('a surrounding tx rollback still undoes an upsert that succeeded', async () => {
    const repo = memoryRepo(items);
    await repo.insert({ id: 'x', code: 'x', slug: 's1' });
    const rows = [
      { id: 'x', code: 'x', slug: 'moved' },
      { id: 'n', code: 'n', slug: 'n' },
    ];
    await memoryTransactor()
      .run(async (tx) => {
        await repo.upsertAll(rows, { tx, onConflict: ['code'] });
        expect.unreachable('rollback');
      })
      .catch(() => undefined);
    expect((await repo.findMany({})).rows.map((row) => [row.id, row.slug])).toEqual([['x', 's1']]);
  });

  test('a clean 40,000-row batch with no unique declared takes under five seconds', async () => {
    const rows = Array.from({ length: 40_000 }, (_, index) => ({ id: `r${index}`, label: 'x' }));
    const started = performance.now();
    await memoryRepo(plain).insertAll(rows);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);
});

// The one undo scope the memory driver has: a batch's and a lock's savepoint.

const bareTx = (undos: (() => void)[]): Tx => ({
  id: 'bare',
  onRollback: (undo) => undos.push(undo),
});

describe('unit · undoingBatch', () => {
  test('an effect runs at once when no outer scope can hold it, rather than being lost', () => {
    let ran = 0;
    undoingBatch(bareTx([]), (scope) => scope.onCommit?.(() => (ran += 1)));
    undoingBatch(undefined, (scope) => scope.onCommit?.(() => (ran += 1)));
    expect(ran).toBe(2);
  });

  test('an outer onCommit holds it', () => {
    const held: (() => void)[] = [];
    let ran = 0;
    const outer: Tx = { ...bareTx([]), onCommit: (effect) => held.push(effect) };
    undoingBatch(outer, (scope) => scope.onCommit?.(() => (ran += 1)));
    expect(ran).toBe(0);
    expect(held).toHaveLength(1);
  });

  test('async work: a rejection undoes, in reverse, and a resolve hands up to the tx', async () => {
    const undone: string[] = [];
    const rejected = undoingBatch(undefined, async (scope) => {
      scope.onRollback(() => undone.push('first'));
      await Promise.resolve();
      scope.onRollback(() => undone.push('second'));
      throw WORK_FAILED;
    });
    await rejected.catch(() => undefined);
    expect(undone).toEqual(['second', 'first']);
    const handed: (() => void)[] = [];
    await undoingBatch(bareTx(handed), async (scope) => {
      await Promise.resolve();
      scope.onRollback(() => undefined);
    });
    expect(handed).toHaveLength(1);
  });
});
