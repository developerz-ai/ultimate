// The `PreferenceStore` contract of `@ultimat3/notify` as checks. The seam has no write side — the
// taxonomy and the opt-outs are the app's (axiom 8) — so what a store owes every caller is the
// shape of its answer: one read per chunk, ids as strings, and the same answer to the same question.

import { expect } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import type { Recipient } from '@ultimat3/notify';
import { NOTIFY_CHUNK_SIZE } from '@ultimat3/notify';
import type { PreferenceBatchQuery, PreferenceStore } from '@ultimat3/notify/adapter';

export interface PreferenceStoreCheck {
  readonly name: string;
  run(store: PreferenceStore): Promise<void>;
}

const AT = new Date('2026-08-24T09:00:00Z');

const queryFor = (recipients: readonly Recipient[]): PreferenceBatchQuery => ({
  recipients,
  notifier: 'post.liked',
  channel: 'email',
  event: { notifier: 'post.liked', key: 'like:p1', params: {}, at: AT },
  ctx: ctxOf({ clock: frozenClock(AT) }),
});

const audience = (size: number): readonly Recipient[] =>
  Array.from({ length: size }, (_, index) => ({ id: `r${index.toString()}`, tz: 'UTC' }));

const answer = async (store: PreferenceStore, query: PreferenceBatchQuery): Promise<string[]> => [
  ...(await store.allowsMany(query)),
];

export const PREFERENCE_STORE_CHECKS: readonly PreferenceStoreCheck[] = [
  {
    name: `a full chunk of ${NOTIFY_CHUNK_SIZE.toString()} is answered by one call, in string ids`,
    async run(store) {
      const ids = await answer(store, queryFor(audience(NOTIFY_CHUNK_SIZE)));
      expect(ids.every((id) => typeof id === 'string')).toBe(true);
    },
  },
  {
    name: 'the same question answers the same set',
    async run(store) {
      const query = queryFor(audience(16));
      const [first, second] = [await answer(store, query), await answer(store, query)];
      expect([...second].sort()).toEqual([...first].sort());
    },
  },
];
