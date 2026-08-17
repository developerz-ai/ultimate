// A cursor is untrusted input handed back by the client: corrupt, tampered, spliced from
// another cursor, or minted for a different resource must all fail closed to page one — never
// decode into a fabricated position. Also pins the no-offset keyset contract itself.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { decodeAdminCursor, encodeAdminCursor, fetchPage, listQuery, pageFrom } from './pagination';
import type { AdminListQuery, AdminRow } from './registry';
import { adminResource } from './resource';

const post = entity('admin_page_post', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    createdAt: timestamp().defaultNow(),
  },
});

const user = entity('admin_page_user', {
  columns: {
    id: uuid().primaryKey(),
    email: text({ max: 120 }).unique(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

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

    const cursor = decodeAdminCursor(resource, page.nextCursor);
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
      {
        cursor: encodeAdminCursor(resource, {
          direction: 'after',
          field: 'createdAt',
          value: 'x',
          id: 'p_2',
        }),
      },
      rows.slice(2),
    );
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(decodeAdminCursor(resource, page.prevCursor)?.direction).toBe('before');
  });

  test('a page-one cursor walks to page two and back, unchanged', () => {
    const first = pageFrom(resource, {}, rows);
    const second = pageFrom(resource, { cursor: first.nextCursor }, rows.slice(2));

    expect(second.rows.map((row) => row['id'])).toEqual(['p_3']);
    expect(listQuery(resource, { cursor: second.prevCursor }).before).toEqual({
      field: 'createdAt',
      value: '2026-07-01T00:00:00.000Z',
      id: 'p_3',
    });
  });

  // Paging backwards is the direction `hasMore` was blind to: it meant "the fetch overflowed",
  // which on a `before` query is a statement about the rows BEHIND this page.
  describe('paging backwards', () => {
    const back = (id: string): string =>
      encodeAdminCursor(resource, {
        direction: 'before',
        field: 'createdAt',
        value: '2026-07-01T00:00:00.000Z',
        id,
      });

    test('a backward page always offers Next — it is the page the operator came from', () => {
      // p_1, p_2 are everything before p_3: no overflow, and yet forward must stay reachable.
      const page = pageFrom(resource, { cursor: back('p_3') }, rows.slice(0, 2));

      expect(page.rows.map((row) => row['id'])).toEqual(['p_1', 'p_2']);
      expect(page.hasMore).toBe(true);
      expect(decodeAdminCursor(resource, page.nextCursor)?.id).toBe('p_2');
    });

    test('a backward page that reached the start offers no way further back', () => {
      const page = pageFrom(resource, { cursor: back('p_3') }, rows.slice(0, 2));
      expect(page.prevCursor).toBeNull();
    });

    test('the overflow row on a backward page is the head, and it means a previous page', () => {
      const older: readonly AdminRow[] = [
        { id: 'p_0', title: 'Zero', createdAt: '2026-07-04T00:00:00.000Z' },
        ...rows.slice(0, 2),
      ];
      const page = pageFrom(resource, { cursor: back('p_3') }, older);

      // The trimmed row is p_0 — the one furthest back — not p_2, which sits against the cursor.
      expect(page.rows.map((row) => row['id'])).toEqual(['p_1', 'p_2']);
      expect(page.hasMore).toBe(true);
      expect(decodeAdminCursor(resource, page.prevCursor)?.id).toBe('p_1');
    });
  });

  test('a corrupt cursor means page one, not an error page', () => {
    expect(decodeAdminCursor(resource, 'not-a-cursor')).toBeNull();
    expect(decodeAdminCursor(resource, '')).toBeNull();
    expect(listQuery(resource, { cursor: 'not-a-cursor' }).after).toBeUndefined();
  });

  test('a tampered signature means page one, never a fabricated position', () => {
    const cursor = encodeAdminCursor(resource, {
      direction: 'after',
      field: 'createdAt',
      value: '2026-07-02T00:00:00.000Z',
      id: 'p_2',
    });
    const flipped = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;

    expect(flipped).not.toBe(cursor);
    expect(decodeAdminCursor(resource, flipped)).toBeNull();
    expect(listQuery(resource, { cursor: flipped }).after).toBeUndefined();
  });

  test('a body spliced onto a signature it was not signed with is refused', () => {
    const mine = encodeAdminCursor(resource, {
      direction: 'after',
      field: 'createdAt',
      value: '2026-07-02T00:00:00.000Z',
      id: 'p_2',
    });
    const forged = encodeAdminCursor(resource, {
      direction: 'after',
      field: 'createdAt',
      value: '1999-01-01T00:00:00.000Z',
      id: 'p_9',
    });
    const spliced = `${forged.slice(0, forged.lastIndexOf('.'))}.${mine.slice(mine.lastIndexOf('.') + 1)}`;

    expect(decodeAdminCursor(resource, spliced)).toBeNull();
    expect(listQuery(resource, { cursor: spliced }).after).toBeUndefined();
  });

  test('a cursor from another resource cannot page this one', () => {
    const users = adminResource(user, { pageSize: 2 });
    const bound = {
      direction: 'after',
      field: 'createdAt',
      value: '2026-07-02T00:00:00.000Z',
      id: 'p_2',
    } as const;
    const postCursor = encodeAdminCursor(resource, bound);

    expect(encodeAdminCursor(users, bound)).not.toBe(postCursor);
    expect(decodeAdminCursor(users, postCursor)).toBeNull();
    expect(listQuery(users, { cursor: postCursor }).after).toBeUndefined();
    expect(decodeAdminCursor(resource, postCursor)).toEqual(bound);
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
