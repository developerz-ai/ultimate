import { beforeEach, describe, expect, test } from 'bun:test';
import { id, orgId, softDelete, table, text } from './columns';
import { type EntitySchema, entity } from './entity';
import { clearRegistry } from './registry';
import { memoryRepo, memoryTransactor } from './repo';

interface Note {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly deletedAt: Date | null;
}

const schema: EntitySchema<Note> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Note }),
  },
};

const seed: readonly Note[] = ['a', 'b', 'c', 'd', 'e'].map((key, index) => ({
  id: `id-${index}`,
  orgId: index < 4 ? 'org-1' : 'org-2',
  title: key,
  deletedAt: null,
}));

const notesEntity = () =>
  entity<Note, ReturnType<typeof notesTable>['columns']>({
    table: notesTable(),
    type: schema,
  });

const notesTable = () =>
  table('notes', { id: id(), orgId: orgId(), title: text(), ...softDelete() });

beforeEach(() => {
  clearRegistry();
});

describe('tenancy guard', () => {
  test('a query for a tenant-scoped entity without an org rejects', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    await expect(repo.findMany()).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
    await expect(repo.findById('id-0')).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
  });

  test('scoped reads only see their own tenant', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    const page = await repo.findMany({ orgId: 'org-1', limit: 10 });
    expect(page.rows).toHaveLength(4);
    expect(page.rows.every((row) => row.orgId === 'org-1')).toBe(true);
    expect(await repo.count({ orgId: 'org-2' })).toBe(1);
  });
});

describe('cursor pagination', () => {
  test('walks every row exactly once', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await repo.findMany({ orgId: 'org-1', limit: 2, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['id-0', 'id-1', 'id-2', 'id-3']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the last page reports no cursor', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    const page = await repo.findMany({ orgId: 'org-1', limit: 10 });
    expect(page.nextCursor).toBeNull();
  });
});

describe('writes', () => {
  test('soft delete hides the row without losing it', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    await repo.delete('id-0', { orgId: 'org-1' });
    expect(await repo.count({ orgId: 'org-1' })).toBe(3);
    expect(await repo.count({ orgId: 'org-1', includeDeleted: true })).toBe(4);
  });

  test('a failed transaction undoes its writes', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    const transactor = memoryTransactor();
    const attempt = transactor.run(async (tx) => {
      await repo.update('id-0', { title: 'changed' }, { tx, orgId: 'org-1' });
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect((await repo.findById('id-0', { orgId: 'org-1' }))?.title).toBe('a');
  });

  test('an update through the outbox tx is visible to the same tx', async () => {
    const repo = memoryRepo(notesEntity(), seed);
    const transactor = memoryTransactor();
    const title = await transactor.run(async (tx) => {
      await repo.update('id-0', { title: 'changed' }, { tx, orgId: 'org-1' });
      const row = await repo.findById('id-0', { orgId: 'org-1' });
      return row?.title;
    });
    expect(title).toBe('changed');
  });
});
