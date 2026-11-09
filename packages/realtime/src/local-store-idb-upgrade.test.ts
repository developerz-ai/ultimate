// A schema bump in one tab and the connections other tabs hold. `onversionchange` never closed,
// and `blocked` was a hard failure: on any bump, a new tab fell back to memory — and an offline
// write queued there was gone with the tab.

import { expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { fakeIndexedDb } from './idb-fake-fixture';
import { openLocalStore } from './local-store-idb';

const quiet = (): { warn: (error: UltimateError) => void; warned: UltimateError[] } => {
  const warned: UltimateError[] = [];
  return { warn: (error) => warned.push(error), warned };
};

/** Let every settled promise run: the fake IndexedDB answers on microtasks, never on a timer. */
const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve();
};

/** A gate a test opens by hand: the other tab closing its connection. */
const gate = (): { opened: Promise<void>; open: () => void } => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

test('an open blocked by another tab waits for it, and lands on IndexedDB', async () => {
  const other = gate();
  const { warn, warned } = quiet();
  const opening = openLocalStore({
    indexedDB: fakeIndexedDb({ blockedUntil: other.opened }),
    warn,
  });
  // `blocked` has fired by now; the other tab closes a moment later, well inside the bound.
  await turns();
  other.open();
  const store = await opening;

  expect(store.kind).toBe('indexeddb');
  expect(warned).toEqual([]);
  // And it is a working store: the outbox a user fills offline is on disk, not in this tab's heap.
  await store.writeQueue('p:u1', { puts: [], deletes: [], nextSeq: 3 });
  expect((await store.queue('p:u1'))?.nextSeq).toBe(3);
});

test('blocked past the bound falls back to memory, warned once, and the late open is let go', async () => {
  const other = gate();
  const { warn, warned } = quiet();
  const idb = fakeIndexedDb({ blockedUntil: other.opened });
  const store = await openLocalStore({ indexedDB: idb, warn, blockedTimeoutMs: 5 });

  expect(store.kind).toBe('memory');
  expect(warned.map((error) => error.code)).toEqual(['X_LOCAL_STORE_UNAVAILABLE']);
  expect(warned[0]?.cause).toContain('blocked');

  // The other tab finally closes: the connection that opens now belongs to nobody, and held open
  // it would block the NEXT upgrade the same way.
  other.open();
  await turns();
  expect(idb.connections).toHaveLength(1);
  expect(idb.connections[0]?.closed).toBe(true);
});

test("another tab's upgrade closes this tab's connection instead of blocking it", async () => {
  const idb = fakeIndexedDb();
  const store = await openLocalStore({ indexedDB: idb, warn: quiet().warn });
  expect(store.kind).toBe('indexeddb');
  expect(idb.connections[0]?.closed).toBe(false);

  idb.versionChange();

  expect(idb.connections[0]?.closed).toBe(true);
});

test('a non-finite bound is refused where the store is opened', async () => {
  const opening = openLocalStore({
    indexedDB: fakeIndexedDb(),
    warn: quiet().warn,
    blockedTimeoutMs: Number.NaN,
  });
  expect(
    await opening.then(
      () => 'opened',
      (error: UltimateError) => error.code,
    ),
  ).toBe('X_INVARIANT');
});
