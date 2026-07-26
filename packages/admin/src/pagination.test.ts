import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, fetchPage, listQuery, pageFrom } from './pagination';
import type { AdminEntity, AdminListQuery, AdminRow } from './registry';
import { adminResource } from './resource';

const post: AdminEntity = {
  name: 'post',
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'varchar', index: true },
    createdAt: { type: 'timestamptz', generated: true },
  },
};

const rows: readonly AdminRow[] = [
  { id: 'p_1', title: 'One', createdAt: '2026-07-03T00:00:00.000Z' },
  { id: 'p_2', title: 'Two', createdAt: '2026-07-02T00:00:00.000Z' },
  { id: 'p_3', title: 'Three', createdAt: '2026-07-01T00:00:00.000Z' },
];

describe('cursor pagination', () => {
  const resource = adminResource(post, { pageSize: 2 });

  test('the query asks for one extra row and never carries an offset', () => {
    const query: AdminListQuery = listQuery(resource);
    expect(query.limit).toBe(3);
    expect(query.sort).toEqual({ field: 'createdAt', direction: 'desc' });
    expect(Object.keys(query)).not.toContain('offset');
    expect(query.after).toBeUndefined();
  });

  test('a full fetch yields a page plus a next cursor keyed on the sort field', () => {
    const page = pageFrom(resource, {}, rows);
    expect(page.rows.map((row) => row['id'])).toEqual(['p_1', 'p_2']);
    expect(page.hasMore).toBe(true);
    expect(page.prevCursor).toBeNull();

    const cursor = decodeCursor(page.nextCursor);
    expect(cursor).toEqual({
      direction: 'after',
      field: 'createdAt',
      value: '2026-07-02T00:00:00.000Z',
      id: 'p_2',
    });
  });

  test('the next cursor becomes a keyset bound, with the id as tie-break', () => {
    const page = pageFrom(resource, {}, rows);
    const query = listQuery(resource, { cursor: page.nextCursor });
    expect(query.after).toEqual({
      field: 'createdAt',
      value: '2026-07-02T00:00:00.000Z',
      id: 'p_2',
    });
    expect(query.before).toBeUndefined();
  });

  test('the last page reports no more, and offers a way back', () => {
    const page = pageFrom(
      resource,
      { cursor: encodeCursor({ direction: 'after', field: 'createdAt', value: 'x', id: 'p_2' }) },
      rows.slice(2),
    );
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(decodeCursor(page.prevCursor)?.direction).toBe('before');
  });

  test('a corrupt cursor means page one, not an error page', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(listQuery(resource, { cursor: 'not-a-cursor' }).after).toBeUndefined();
  });

  test('fetchPage passes the derived query straight to the repo', async () => {
    const seen: AdminListQuery[] = [];
    const bound = adminResource(post, {
      pageSize: 2,
      repo: {
        list: async (query): Promise<readonly AdminRow[]> => {
          seen.push(query);
          return rows;
        },
        find: async (): Promise<AdminRow | null> => null,
        create: async (): Promise<AdminRow> => ({}),
        update: async (): Promise<AdminRow> => ({}),
        destroy: async (): Promise<void> => undefined,
      },
    });

    const page = await fetchPage(bound, { limit: 2 });
    expect(seen[0]?.limit).toBe(3);
    expect(page.rows.length).toBe(2);
    expect(page.hasMore).toBe(true);
  });
});
