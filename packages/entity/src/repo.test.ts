import { afterAll, describe, expect, test } from 'bun:test';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { decodeCursor, memoryRepo, memoryTransactor } from './repo';

const notes = entity('repo_test_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    deletedAt: timestamp().nullable(),
  },
});

type Note = typeof notes.$row;

const org = (index: number): string => `00000000-0000-7000-8000-00000000000${index}`;

const seed: readonly Note[] = ['a', 'b', 'c', 'd', 'e'].map((title, index) => ({
  id: `00000000-0000-7000-8000-00000000010${index}`,
  orgId: index < 4 ? org(1) : org(2),
  title,
  deletedAt: null,
}));

const ids = seed.map((note) => note.id);

afterAll(() => {
  clearRegistry();
});

describe('tenancy guard', () => {
  test('a query for a tenant-scoped entity without an org rejects', async () => {
    const repo = memoryRepo(notes, seed);
    await expect(repo.findMany()).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
    await expect(repo.findById(ids[0] ?? '')).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
    await expect(repo.count()).rejects.toThrow(/X_TENANCY_UNSCOPED/);
  });

  test('scoped reads only see their own tenant', async () => {
    const repo = memoryRepo(notes, seed);
    const page = await repo.findMany({ orgId: org(1), limit: 10 });
    expect(page.rows).toHaveLength(4);
    expect(page.rows.every((row) => row.orgId === org(1))).toBe(true);
    expect(await repo.count({ orgId: org(2) })).toBe(1);
  });
});

describe('cursor pagination', () => {
  test('walks every row exactly once', async () => {
    const repo = memoryRepo(notes, seed);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await repo.findMany({ orgId: org(1), limit: 2, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(ids.slice(0, 4));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the cursor names a position in the sort order, never a row count', async () => {
    const repo = memoryRepo(notes, seed);
    const first = await repo.findMany({ orgId: org(1), limit: 2 });
    const decoded = decodeCursor(first.nextCursor ?? '');
    expect(decoded?.id).toBe(ids[1] ?? '');
    // An insert before the page boundary must not shift the next page — the failure OFFSET has.
    await repo.insert({
      id: '00000000-0000-7000-8000-000000000999',
      orgId: org(1),
      title: 'inserted first',
      deletedAt: null,
    });
    const second = await repo.findMany({ orgId: org(1), limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2, 4));
  });

  test('the last page reports no cursor', async () => {
    const repo = memoryRepo(notes, seed);
    expect((await repo.findMany({ orgId: org(1), limit: 10 })).nextCursor).toBeNull();
  });
});

describe('writes', () => {
  test('soft delete hides the row without losing it', async () => {
    const repo = memoryRepo(notes, seed);
    await repo.delete(ids[0] ?? '', { orgId: org(1) });
    expect(await repo.count({ orgId: org(1) })).toBe(3);
    expect(await repo.count({ orgId: org(1), includeDeleted: true })).toBe(4);
  });

  test('a failed transaction undoes its writes', async () => {
    const repo = memoryRepo(notes, seed);
    const transactor = memoryTransactor();
    const attempt = transactor.run(async (tx) => {
      await repo.update(ids[0] ?? '', { title: 'changed' }, { tx, orgId: org(1) });
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect((await repo.findById(ids[0] ?? '', { orgId: org(1) }))?.title).toBe('a');
  });

  test('an update through the outbox tx is visible to the same tx', async () => {
    const repo = memoryRepo(notes, seed);
    const transactor = memoryTransactor();
    const title = await transactor.run(async (tx) => {
      await repo.update(ids[0] ?? '', { title: 'changed' }, { tx, orgId: org(1) });
      return (await repo.findById(ids[0] ?? '', { orgId: org(1) }))?.title;
    });
    expect(title).toBe('changed');
  });

  test('a composite key has no single id, and says so instead of guessing', async () => {
    const likes = entity('repo_test_likes', {
      columns: { postId: uuid(), memberId: uuid() },
      primaryKey: ['postId', 'memberId'],
    });
    const repo = memoryRepo(likes);
    await repo.insert({ postId: org(1), memberId: org(2) });
    expect((await repo.findMany({ limit: 10 })).rows).toHaveLength(1);
    await expect(repo.findById(org(1))).rejects.toThrow(/composite primary key/);
  });
});
