// The Postgres inbox over a recording executor. The statements are the contract here — a page that
// forgets its tail key drops rows at a boundary, and a `mark read` that forgets its recipient is a
// write into somebody else's inbox.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/jobs';
import type { InboxStore } from './inbox';
import { createMemoryInboxStore } from './inbox';
import {
  createPgInboxStore,
  SQL_NOTIFY_INBOX_ADD,
  SQL_NOTIFY_INBOX_MARK_READ,
  SQL_NOTIFY_INBOX_MARK_SEEN,
  SQL_NOTIFY_INBOX_PAGE,
  SQL_NOTIFY_INBOX_TABLE,
} from './inbox-pg';

const AT = new Date('2026-08-24T09:00:00Z');

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const recording = (rows: readonly unknown[], calls: Call[]): PgExecutor => ({
  query: <R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> => {
    calls.push({ sql, params });
    return Promise.resolve(rows as readonly R[]);
  },
});

describe('unit · postgres inbox', () => {
  test('add is keyed on (recipient, notifier, key), and the id is injectable', async () => {
    const calls: Call[] = [];
    const store = createPgInboxStore({
      executor: recording(
        [
          {
            id: 'fixed-id',
            recipient: 'ana',
            notifier: 'post.liked',
            key: 'like:p1',
            params: { postId: 'p1' },
            created_at: AT,
            seen_at: null,
            read_at: null,
          },
        ],
        calls,
      ),
      // A `random = Math.random` default parameter is the repo's injectable seam; this is the
      // same shape for an id, so shipped source never calls a die a test cannot control.
      newId: () => 'fixed-id',
    });

    const row = await store.add({
      recipient: 'ana',
      notifier: 'post.liked',
      key: 'like:p1',
      params: { postId: 'p1' },
      createdAt: AT,
    });

    expect(row.id).toBe('fixed-id');
    expect(row.readAt).toBeNull();
    expect(calls[0]?.sql).toBe(SQL_NOTIFY_INBOX_ADD);
    expect(SQL_NOTIFY_INBOX_ADD).toContain('on conflict (recipient, notifier, key) do nothing');
    expect(SQL_NOTIFY_INBOX_TABLE).toContain('unique (recipient, notifier, key)');
  });

  test('list maps the row shape back, and an unread-only page says so in a parameter', async () => {
    const calls: Call[] = [];
    const store = createPgInboxStore({
      executor: recording(
        [
          {
            id: 'row-1',
            recipient: 'ana',
            notifier: 'post.liked',
            key: 'like:p1',
            params: { postId: 'p1' },
            created_at: '2026-08-24T09:00:00.000Z',
            seen_at: '2026-08-24T09:01:00.000Z',
            read_at: null,
          },
        ],
        calls,
      ),
    });

    const page = await store.list({ recipient: 'ana', unreadOnly: true, limit: 10 });
    expect(calls[0]?.params).toEqual(['ana', true, 10]);
    // A `timestamptz` may arrive as a Date or as a string depending on the driver; both become a
    // Date here, so a page never hands a caller two different types for one column.
    expect(page[0]?.createdAt).toEqual(AT);
    expect(page[0]?.seenAt).toEqual(new Date('2026-08-24T09:01:00.000Z'));
    expect(page[0]?.readAt).toBeNull();
  });

  test('an unread count with no row back is zero, never undefined', async () => {
    const empty = createPgInboxStore({ executor: recording([], []) });
    expect(await empty.unreadCount('ana')).toBe(0);
    const counted = createPgInboxStore({ executor: recording([{ unread: 7 }], []) });
    expect(await counted.unreadCount('ana')).toBe(7);
  });

  test('the page orders by (created_at desc, id), so a bounded page has a total order', () => {
    expect(SQL_NOTIFY_INBOX_PAGE).toContain('order by created_at desc, id');
  });

  test('the unread index is PARTIAL, because `read_at is null` is the query every page load runs', () => {
    expect(SQL_NOTIFY_INBOX_TABLE).toContain('on x_notify_inbox (recipient) where read_at is null');
  });

  test('every write is scoped by recipient, so a stranger id reaches no row', async () => {
    const calls: Call[] = [];
    const store = createPgInboxStore({ executor: recording([], calls) });
    await store.markRead({ recipient: 'ana', ids: ['x'], at: AT });
    await store.markSeen({ recipient: 'ana', at: AT });
    expect(SQL_NOTIFY_INBOX_MARK_READ).toContain('where recipient = $1 and id = any($2::uuid[])');
    expect(SQL_NOTIFY_INBOX_MARK_SEEN).toContain('where recipient = $1 and seen_at is null');
    expect(calls.map((call) => call.params[0])).toEqual(['ana', 'ana']);
  });
});

/**
 * The two drivers must screen the page bound identically, because they are one interface an app
 * swaps between boot modes. They did not: the memory store's `slice(0, NaN)` answered `[]` — an
 * empty inbox reported as the whole of it — while `limit $3` reached Postgres as `NaN` and the
 * driver decided what that meant. `slice(0, Infinity)` was worse still: every row the recipient
 * ever received, out of the call whose own doc says an inbox is a page.
 */
describe('unit · both inbox drivers answer one question one way', () => {
  const pg = (): InboxStore => createPgInboxStore({ executor: recording([], []) });

  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
    test(`limit: ${String(limit)} is refused by BOTH drivers`, async () => {
      await expect(createMemoryInboxStore().list({ recipient: 'ana', limit })).rejects.toThrow(
        /X_INVARIANT/,
      );
      await expect(pg().list({ recipient: 'ana', limit })).rejects.toThrow(/X_INVARIANT/);
    });
  }

  test('limit: 0 is an empty page from both, and the statement still carries the bound', async () => {
    const calls: Call[] = [];
    const store = createPgInboxStore({ executor: recording([], calls) });
    expect(await store.list({ recipient: 'ana', limit: 0 })).toEqual([]);
    expect(calls[0]?.params[2]).toBe(0);
    expect(await createMemoryInboxStore().list({ recipient: 'ana', limit: 0 })).toEqual([]);
  });
});
