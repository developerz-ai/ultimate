// The in-app inbox: seen and read as two facts, an unread count DERIVED rather than stored, and a
// write that converges — because the job that produced it is at-least-once.

import { describe, expect, test } from 'bun:test';
import { createMemoryInboxStore } from './inbox';

const AT = new Date('2026-08-24T09:00:00Z');
const LATER = new Date('2026-08-24T10:00:00Z');
const write = {
  recipient: 'ana',
  notifier: 'post.liked',
  key: 'like:p1',
  params: { postId: 'p1' },
};

describe('unit · in-app inbox', () => {
  test('a replayed add returns the FIRST row rather than moving its timestamps', async () => {
    const inbox = createMemoryInboxStore();
    const first = await inbox.add({ ...write, createdAt: AT });
    await inbox.markRead({ recipient: 'ana', ids: [first.id], at: AT });
    const again = await inbox.add({ ...write, createdAt: LATER });

    expect(inbox.size).toBe(1);
    expect(again.createdAt).toEqual(AT);
    // Still read: a replayed job must not resurrect a message the user already dismissed.
    expect(again.readAt).toEqual(AT);
  });

  test('the unread count is derived from the rows, so the badge and the list cannot disagree', async () => {
    const inbox = createMemoryInboxStore();
    const one = await inbox.add({ ...write, createdAt: AT });
    await inbox.add({ ...write, key: 'like:p2', createdAt: LATER });
    expect(await inbox.unreadCount('ana')).toBe(2);

    expect(await inbox.markRead({ recipient: 'ana', ids: [one.id], at: LATER })).toBe(1);
    expect(await inbox.unreadCount('ana')).toBe(1);
    expect((await inbox.list({ recipient: 'ana', unreadOnly: true })).map((r) => r.key)).toEqual([
      'like:p2',
    ]);
  });

  test('marking read is scoped by recipient, so a stranger id is simply absent', async () => {
    const inbox = createMemoryInboxStore();
    const mine = await inbox.add({ ...write, createdAt: AT });
    expect(await inbox.markRead({ recipient: 'ben', ids: [mine.id], at: LATER })).toBe(0);
    expect(await inbox.unreadCount('ana')).toBe(1);
  });

  test('seen and read are two facts: showing the badge does not dismiss the message', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, createdAt: AT });
    expect(await inbox.markSeen({ recipient: 'ana', at: AT })).toBe(1);
    // Seen, and still unread — collapsing the two would empty the list the moment it rendered.
    expect(await inbox.unreadCount('ana')).toBe(1);
    expect((await inbox.list({ recipient: 'ana' }))[0]?.seenAt).toEqual(AT);
    // Idempotent: a second render marks nothing.
    expect(await inbox.markSeen({ recipient: 'ana', at: LATER })).toBe(0);
  });

  test('clear() empties the store, so one suite cannot leak into the next', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, createdAt: AT });
    inbox.clear();
    expect(inbox.size).toBe(0);
    expect(await inbox.unreadCount('ana')).toBe(0);
  });

  test('the page is newest first and bounded', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, key: 'a', createdAt: AT });
    await inbox.add({ ...write, key: 'b', createdAt: LATER });
    expect((await inbox.list({ recipient: 'ana', limit: 1 })).map((r) => r.key)).toEqual(['b']);
  });
});

/**
 * `slice(0, NaN)` is `[]` and `slice(0, Infinity)` is EVERY row — one silently reports an empty
 * inbox as the whole of it, the other is the unbounded read the `limit` exists to prevent. Neither
 * is reachable through the `??` default, because `NaN` is not nullish.
 */
describe('unit · in-memory inbox, a page size that is not one', () => {
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
    test(`limit: ${String(limit)} is refused, never answered as a page`, async () => {
      const inbox = createMemoryInboxStore();
      await inbox.add({ ...write, key: 'a', createdAt: AT });
      await expect(inbox.list({ recipient: 'ana', limit })).rejects.toThrow(/X_INVARIANT/);
    });
  }

  test('limit: 0 is an empty page, which is a bound and not a mistake', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, key: 'a', createdAt: AT });
    expect(await inbox.list({ recipient: 'ana', limit: 0 })).toEqual([]);
  });
});

/**
 * `SQL_NOTIFY_INBOX_PAGE` orders `created_at desc, notifier, key` — a tail that is unique within a
 * recipient, so a bounded page cannot drop or repeat a row. The memory store sorted on `createdAt`
 * alone, which is a PARTIAL order: two notifications written in the same millisecond could come
 * back either way round, and the two drivers behind one interface then answer one question two ways.
 *
 * `id` was the tail until 2026-09-06 and was never a shared one: this store derives it from
 * `JSON.stringify([recipient, notifier, key])` and compares by code point, while `createPgInboxStore`
 * mints a UUIDv7 that Postgres orders by its 16 bytes.
 */
describe('unit · two notifications in the same millisecond', () => {
  test('the memory page breaks the tie on (notifier, key), exactly as the statement does', async () => {
    const inbox = createMemoryInboxStore();
    // Inserted newest-key-first, so an implementation that keeps insertion order fails this.
    await inbox.add({ ...write, key: 'like:zz', createdAt: AT });
    await inbox.add({ ...write, key: 'like:aa', createdAt: AT });

    const page = await inbox.list({ recipient: 'ana' });

    expect(page.map((row) => row.key)).toEqual(['like:aa', 'like:zz']);
  });

  // The notifier outranks the key, which is what `order by … notifier, key` says and what an
  // implementation sorting on the key alone gets wrong.
  test('the notifier is the first tie-break and the key the second', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, notifier: 'zeta', key: 'aa', createdAt: AT });
    await inbox.add({ ...write, notifier: 'alpha', key: 'zz', createdAt: AT });

    const page = await inbox.list({ recipient: 'ana' });

    expect(page.map((row) => `${row.notifier}/${row.key}`)).toEqual(['alpha/zz', 'zeta/aa']);
  });

  // CODE POINT, never `localeCompare` — which is what `collate "C"` pins on the Postgres side.
  // `é` sorts after `z` by code point and BEFORE it under an ICU or `en_US.UTF-8` collation, so a
  // store comparing by locale would answer the other way round and the two drivers would split.
  test('the comparison is by code point, so a Unicode key cannot split the two stores', async () => {
    const inbox = createMemoryInboxStore();
    for (const key of ['zz', 'école', 'Zürich', 'aa']) {
      await inbox.add({ ...write, key, createdAt: AT });
    }

    const page = await inbox.list({ recipient: 'ana' });

    expect(page.map((row) => row.key)).toEqual(['Zürich', 'aa', 'zz', 'école']);
  });

  test('a newer row still outranks an older one whatever its id', async () => {
    const inbox = createMemoryInboxStore();
    await inbox.add({ ...write, key: 'like:aa', createdAt: AT });
    await inbox.add({ ...write, key: 'like:zz', createdAt: LATER });

    const page = await inbox.list({ recipient: 'ana' });

    expect(page.map((row) => row.key)).toEqual(['like:zz', 'like:aa']);
  });
});
