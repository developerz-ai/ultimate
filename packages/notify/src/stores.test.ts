// The four seams, and which of them may have a default. A ledger with a dev default is safer than
// no ledger at all; an inbox with one would be a notification written to a heap nobody reads.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMemoryDigestStore } from './digest';
import { createMemoryInboxStore } from './inbox';
import { createMemoryDeliveryLedger } from './ledger';
import { createMemoryPreferenceStore } from './preferences';
import {
  notifyStores,
  requireDigest,
  requireInbox,
  resetNotifyStores,
  setNotifyStores,
} from './stores';

afterEach(() => {
  resetNotifyStores();
});

describe('unit · notify stores', () => {
  test('a ledger and a preference store always exist; an inbox and a digest do not', () => {
    const installed = notifyStores();
    expect(installed.ledger).toBeDefined();
    expect(installed.preferences).toBeDefined();
    expect(installed.inbox).toBeUndefined();
    expect(installed.digest).toBeUndefined();
  });

  test('the default preference store allows, because denying by default hides a missing email', () => {
    expect(
      notifyStores().preferences.allows({
        recipient: { id: 'ana' },
        notifier: 'post.liked',
        channel: 'email',
        event: { notifier: 'post.liked', key: 'k', params: {}, at: new Date(0) },
        ctx: { now: () => new Date(0) } as never,
      }),
    ).toBe(true);
  });

  test('install is a whole-object replacement, never a merge', () => {
    setNotifyStores({ inbox: createMemoryInboxStore(), digest: createMemoryDigestStore() });
    expect(notifyStores().inbox).toBeDefined();
    // A merge would leave the first call's inbox live and the second call's omission silent —
    // exactly the split-brain a partial driver override produces.
    setNotifyStores({ ledger: createMemoryDeliveryLedger() });
    expect(notifyStores().inbox).toBeUndefined();
    expect(notifyStores().digest).toBeUndefined();
  });

  test('a missing store refuses by name rather than skipping the write in silence', () => {
    expect(() => requireInbox('post.liked')).toThrow(/inbox store is installed/);
    expect(() => requireDigest('post.liked')).toThrow(/digest store is installed/);
    setNotifyStores({ inbox: createMemoryInboxStore(), digest: createMemoryDigestStore() });
    expect(requireInbox('post.liked')).toBeDefined();
    expect(requireDigest('post.liked')).toBeDefined();
  });

  test('a memory preference store denies one channel and leaves the rest alone', () => {
    const preferences = createMemoryPreferenceStore();
    preferences.deny({ recipient: 'ana', notifier: '*', channel: 'email' });
    const query = {
      recipient: { id: 'ana' },
      notifier: 'post.liked',
      event: { notifier: 'post.liked', key: 'k', params: {}, at: new Date(0) },
      ctx: { now: () => new Date(0) } as never,
    };
    expect(preferences.allows({ ...query, channel: 'email' })).toBe(false);
    expect(preferences.allows({ ...query, channel: 'push' })).toBe(true);
  });
});
