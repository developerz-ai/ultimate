// What the sweep does with each of the four states it can find the seam in: no store, a memory
// store, a Postgres store, and a Postgres store with no window configured. Three of those must be
// zero and silent, because a boot that never configured retention has made a decision.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMemoryInboxStore } from './inbox';
import type { InboxPurgeBefore, PgInboxStore } from './inbox-pg';
import { createMemoryDeliveryLedger } from './ledger';
import type { PgDeliveryLedger } from './ledger-pg';
import { purgeNotifyDeliveries, purgeNotifyInbox } from './retention';
import { resetNotifyStores, setNotifyStores } from './stores';

const AT = new Date('2026-08-24T09:00:00Z');

/** A Postgres inbox as far as the capability check is concerned: it has the method. */
const purgeableInbox = (calls: InboxPurgeBefore[]): PgInboxStore => ({
  ...createMemoryInboxStore(),
  purgeBefore: (before) => {
    calls.push(before);
    return Promise.resolve(7);
  },
});

const purgeableLedger = (calls: number[]): PgDeliveryLedger => ({
  ...createMemoryDeliveryLedger(),
  windowMs: 60_000,
  purgeExpired: (nowMs) => {
    calls.push(nowMs);
    return Promise.resolve(3);
  },
});

afterEach(() => resetNotifyStores());

describe('unit · notify retention seam', () => {
  test('no inbox installed sweeps nothing and does not throw', async () => {
    setNotifyStores({});
    expect(await purgeNotifyInbox({ read: AT })).toBe(0);
  });

  // The one that matters, and the one a `typeof store.purgeBefore` check exists for: the memory
  // inbox is a heap map bounded by process life. Reaching for a method it does not have is a
  // `TypeError` inside the hourly sweep, which would take the other four targets down with it.
  test('a memory inbox sweeps nothing and does not throw', async () => {
    setNotifyStores({ inbox: createMemoryInboxStore() });
    expect(await purgeNotifyInbox({ read: AT, unread: AT })).toBe(0);
  });

  test('a purgeable inbox is handed both cutoffs verbatim', async () => {
    const calls: InboxPurgeBefore[] = [];
    setNotifyStores({ inbox: purgeableInbox(calls) });
    expect(await purgeNotifyInbox({ read: AT })).toBe(7);
    expect(calls).toEqual([{ read: AT }]);
  });

  // The default ledger is the MEMORY one — `setNotifyStores({})` installs it rather than leaving
  // the seam empty — so this is the state every app that never wired Postgres notify is in.
  test('the default memory ledger sweeps nothing', async () => {
    setNotifyStores({});
    expect(await purgeNotifyDeliveries(AT.getTime())).toBe(0);
  });

  test('a purgeable ledger is handed the caller clock', async () => {
    const calls: number[] = [];
    setNotifyStores({ ledger: purgeableLedger(calls) });
    expect(await purgeNotifyDeliveries(AT.getTime())).toBe(3);
    expect(calls).toEqual([AT.getTime()]);
  });

  // A store the seam has never seen — an app's own implementation — must read as unpurgeable
  // rather than as a crash. The capability check is on the METHOD, so a property that happens to
  // share the name but is not callable is not a store this can sweep either.
  test('a foreign store carrying a non-function of the same name is not swept', async () => {
    const notAMethod = { ...createMemoryInboxStore(), purgeBefore: 'soon' };
    setNotifyStores({ inbox: notAMethod as unknown as PgInboxStore });
    expect(await purgeNotifyInbox({ read: AT })).toBe(0);
  });
});
