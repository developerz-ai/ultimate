// Single responsibility: a memory-driver write that MOVED a row's primary key is undone whole by
// the surrounding transaction's rollback — the row back under its old key, nothing under the new.
import { afterAll, describe, expect, test } from 'bun:test';
import { text } from './columns';
import { entity } from './entity';
import { memoryRepo, memoryTransactor } from './memory-repo';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const slugs = entity('mr_slugs', { columns: { id: text().primaryKey(), label: text() } });

describe('unit · a primary-key move rolls back', () => {
  test('the row is found under its old key again, and the new key is empty', async () => {
    const repo = memoryRepo(slugs);
    await repo.insert({ id: 'old', label: 'kept' });
    let underNew: string | undefined;
    await memoryTransactor()
      .run(async (tx) => {
        await repo.update('old', { id: 'new' }, { tx });
        underNew = (await repo.findById('new'))?.label;
        expect.unreachable('rollback');
      })
      .catch(() => undefined);
    // The move landed inside the transaction, so the rollback below has something to undo.
    expect(underNew).toBe('kept');
    expect((await repo.findById('old'))?.label).toBe('kept');
    expect(await repo.findById('new')).toBeNull();
    expect((await repo.findMany({})).rows.map((row) => row.id)).toEqual(['old']);
  });
});
