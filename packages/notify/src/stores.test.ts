// The four seams, and which of them may have a default. A ledger with a dev default is safer than
// no ledger at all; an inbox with one would be a notification written to a heap nobody reads.

import { afterEach, describe, expect, test } from 'bun:test';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { memoryDigestStore } from './digest';
import { memoryInboxStore } from './inbox';
import { memoryDeliveryLedger } from './ledger';
import { memoryPreferenceStore } from './preferences';
import { notifyStores, requireDigest, requireInbox } from './stores';

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
    const allowed = notifyStores().preferences.allowsMany({
      recipients: [{ id: 'ana' }, { id: 'ben' }],
      notifier: 'post.liked',
      channel: 'email',
      event: { notifier: 'post.liked', key: 'k', params: {}, at: new Date(0) },
      ctx: { now: () => new Date(0) } as never,
    });
    expect([...(allowed as Iterable<string>)]).toEqual(['ana', 'ben']);
  });

  test('install is a whole-object replacement, never a merge', () => {
    installNotifyStores({ inbox: memoryInboxStore(), digest: memoryDigestStore() });
    expect(notifyStores().inbox).toBeDefined();
    // A merge would leave the first call's inbox live and the second call's omission silent —
    // exactly the split-brain a partial driver override produces.
    installNotifyStores({ ledger: memoryDeliveryLedger() });
    expect(notifyStores().inbox).toBeUndefined();
    expect(notifyStores().digest).toBeUndefined();
  });

  test('a missing store refuses by name rather than skipping the write in silence', () => {
    expect(() => requireInbox('post.liked')).toThrow(/inbox store is installed/);
    expect(() => requireDigest('post.liked')).toThrow(/digest store is installed/);
    installNotifyStores({ inbox: memoryInboxStore(), digest: memoryDigestStore() });
    expect(requireInbox('post.liked')).toBeDefined();
    expect(requireDigest('post.liked')).toBeDefined();
  });

  test('a memory preference store denies one channel and leaves the rest alone', () => {
    const preferences = memoryPreferenceStore();
    preferences.deny({ recipient: 'ana', notifier: '*', channel: 'email' });
    const query = {
      recipients: [{ id: 'ana' }, { id: 'ben' }],
      notifier: 'post.liked',
      event: { notifier: 'post.liked', key: 'k', params: {}, at: new Date(0) },
      ctx: { now: () => new Date(0) } as never,
    };
    expect(preferences.allowsMany({ ...query, channel: 'email' })).toEqual(['ben']);
    expect(preferences.allowsMany({ ...query, channel: 'push' })).toEqual(['ana', 'ben']);
  });
});

/**
 * The memory ledger is one process's heap: behind two replicas, or across a restart, a replayed
 * attempt claims cleanly and sends twice. So it is the default only where that is acceptable —
 * development and test — and anywhere else the first claim is refused by name.
 */
describe('unit · the default delivery ledger outside development', () => {
  const claim = { notifier: 'post.liked', key: 'k', recipient: 'ana', channel: 'email' };
  const saved = { ultimate: Bun.env['ULTIMATE_ENV'] };

  afterEach(() => {
    if (saved.ultimate === undefined) delete Bun.env['ULTIMATE_ENV'];
    else Bun.env['ULTIMATE_ENV'] = saved.ultimate;
  });

  for (const environment of ['production', 'staging'] as const) {
    test(`${environment}: the first claim refuses with X_NOTIFY_STORE_MISSING, naming runtime.ts`, async () => {
      Bun.env['ULTIMATE_ENV'] = environment;
      const error = await notifyStores()
        .ledger.claim(claim, new Date(0))
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeUltimateError('X_NOTIFY_STORE_MISSING');
      expect(String((error as { fix: unknown }).fix)).toContain('postgresDeliveryLedger');
      await expect(notifyStores().ledger.find(claim)).rejects.toThrow(/X_NOTIFY_STORE_MISSING/);
    });
  }

  test('test: the memory default dedupes within the process, as it always did', async () => {
    Bun.env['ULTIMATE_ENV'] = 'test';
    const ledger = notifyStores().ledger;
    const first = await ledger.claim(claim, new Date(0));
    if (first.outcome !== 'owned') return expect.unreachable(`got ${first.outcome}`);
    await ledger.settle(claim, 'sent', new Date(0), first.claimId);
    expect(await notifyStores().ledger.claim(claim, new Date(0))).toEqual({ outcome: 'sent' });
  });

  test('an installed ledger is used in production, whatever the default does', async () => {
    Bun.env['ULTIMATE_ENV'] = 'production';
    installNotifyStores({ ledger: memoryDeliveryLedger() });
    expect((await notifyStores().ledger.claim(claim, new Date(0))).outcome).toBe('owned');
  });
});
