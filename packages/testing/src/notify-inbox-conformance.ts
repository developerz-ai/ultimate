// The `InboxStore` contract of `@ultimat3/notify` as checks: a write that converges under an
// at-least-once job, seen and read as two facts, an unread count derived from the rows, and ONE
// total page order `(createdAt desc, notifier, key)` by code point. Every check reads its own
// recipient, so one shared table serves them all.

import { expect } from 'bun:test';
import type { InboxStore, InboxWrite } from '@ultimat3/notify/adapter';

export interface InboxStoreCheck {
  readonly name: string;
  run(inbox: InboxStore): Promise<void>;
}

const AT = new Date('2026-08-24T09:00:00Z');
const LATER = new Date('2026-08-24T10:00:00Z');

let minted = 0;
const recipientOf = (): string => {
  minted += 1;
  return `conformance-${process.pid.toString(36)}-${minted.toString(36)}`;
};

const writeFor = (recipient: string, overrides: Partial<InboxWrite> = {}): InboxWrite => ({
  recipient,
  notifier: 'post.liked',
  key: 'like:p1',
  params: { postId: 'p1', tags: ['a', 'b'] },
  createdAt: AT,
  ...overrides,
});

const pageKeys = async (inbox: InboxStore, recipient: string): Promise<readonly string[]> =>
  (await inbox.list({ recipient })).map((row) => `${row.notifier}/${row.key}`);

export const INBOX_STORE_CHECKS: readonly InboxStoreCheck[] = [
  {
    name: 'a replayed add answers the FIRST row, its timestamps and its read state unmoved',
    async run(inbox) {
      const ana = recipientOf();
      const first = await inbox.add(writeFor(ana));
      expect(first).toMatchObject({ recipient: ana, seenAt: null, readAt: null, createdAt: AT });
      expect(first.params).toEqual({ postId: 'p1', tags: ['a', 'b'] });
      await inbox.markRead({ recipient: ana, ids: [first.id], at: AT });
      const again = await inbox.add(writeFor(ana, { createdAt: LATER, params: { other: 1 } }));
      expect([again.id, again.createdAt, again.readAt]).toEqual([first.id, AT, AT]);
      expect(await inbox.list({ recipient: ana })).toHaveLength(1);
    },
  },
  {
    name: 'the unread count is derived from the rows, so the badge and the list cannot disagree',
    async run(inbox) {
      const ana = recipientOf();
      const one = await inbox.add(writeFor(ana));
      await inbox.add(writeFor(ana, { key: 'like:p2', createdAt: LATER }));
      expect(await inbox.unreadCount(ana)).toBe(2);
      expect(await inbox.markRead({ recipient: ana, ids: [one.id], at: LATER })).toBe(1);
      expect(await inbox.markRead({ recipient: ana, ids: [one.id], at: LATER })).toBe(0);
      expect(await inbox.unreadCount(ana)).toBe(1);
      const unread = await inbox.list({ recipient: ana, unreadOnly: true });
      expect(unread.map((row) => row.key)).toEqual(['like:p2']);
    },
  },
  {
    name: 'marking read is scoped by recipient: a stranger id, or no id at all, is simply absent',
    async run(inbox) {
      const [ana, ben] = [recipientOf(), recipientOf()];
      const mine = await inbox.add(writeFor(ana));
      const good = await inbox.add(writeFor(ana, { key: 'like:p2' }));
      expect(await inbox.markRead({ recipient: ben, ids: [mine.id], at: LATER })).toBe(0);
      // One malformed id must not cost the batch the good ones beside it.
      const ids = ['not-an-id', good.id, crypto.randomUUID()];
      expect(await inbox.markRead({ recipient: ana, ids, at: LATER })).toBe(1);
      expect(await inbox.unreadCount(ana)).toBe(1);
    },
  },
  {
    name: 'seen and read are two facts: showing the badge does not dismiss the message',
    async run(inbox) {
      const ana = recipientOf();
      await inbox.add(writeFor(ana));
      expect(await inbox.markSeen({ recipient: ana, at: AT })).toBe(1);
      expect(await inbox.unreadCount(ana)).toBe(1);
      expect((await inbox.list({ recipient: ana }))[0]?.seenAt).toEqual(AT);
      expect(await inbox.markSeen({ recipient: ana, at: LATER })).toBe(0);
    },
  },
  {
    name: 'the page is newest first and bounded, and limit 0 is an empty page',
    async run(inbox) {
      const ana = recipientOf();
      await inbox.add(writeFor(ana, { key: 'a', createdAt: AT }));
      await inbox.add(writeFor(ana, { key: 'b', createdAt: LATER }));
      expect((await inbox.list({ recipient: ana, limit: 1 })).map((r) => r.key)).toEqual(['b']);
      expect(await inbox.list({ recipient: ana, limit: 0 })).toEqual([]);
    },
  },
  {
    name: 'a limit that is not a count is refused, never answered as a page',
    async run(inbox) {
      const ana = recipientOf();
      await inbox.add(writeFor(ana));
      for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
        await expect(inbox.list({ recipient: ana, limit })).rejects.toThrow();
      }
    },
  },
  {
    name: 'one millisecond: the tie breaks on notifier, then key, by code point',
    async run(inbox) {
      const ana = recipientOf();
      // Inserted against the order, so a store keeping insertion order fails.
      for (const [notifier, key] of [
        ['zeta', 'aa'],
        ['alpha', 'zz'],
        ['alpha', 'école'],
        ['alpha', 'Zürich'],
        ['alpha', 'aa'],
      ] as const) {
        await inbox.add(writeFor(ana, { notifier, key }));
      }
      expect(await pageKeys(inbox, ana)).toEqual([
        'alpha/Zürich',
        'alpha/aa',
        'alpha/zz',
        'alpha/école',
        'zeta/aa',
      ]);
    },
  },
];
