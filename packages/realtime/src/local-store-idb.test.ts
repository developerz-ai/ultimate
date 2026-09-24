import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { type FakeIdbOptions, fakeIndexedDb } from './idb-fake';
import type { LocalStore } from './local-store-idb';
import { MemoryLocalStore, openLocalStore, scopeKey } from './local-store-idb';

const quiet = (): { warn: (error: UltimateError) => void; warned: UltimateError[] } => {
  const warned: UltimateError[] = [];
  return { warn: (error) => warned.push(error), warned };
};

async function seed(store: LocalStore): Promise<void> {
  await store.write(
    'p:u1',
    [
      { type: 'post', key: 'p1', row: { id: 'p1', title: 'one' } },
      { type: 'post', key: 'p2', row: { id: 'p2', title: 'two' } },
    ],
    [],
  );
  await store.write('p:u2', [{ type: 'post', key: 'p9', row: { id: 'p9' } }], []);
  await store.writeQueue('p:u1', { puts: [], deletes: [], nextSeq: 4 });
  await store.writeQueue('p:u2', { puts: [], deletes: [], nextSeq: 7 });
}

describe.each([
  ['indexeddb', () => openLocalStore({ indexedDB: fakeIndexedDb(), warn: quiet().warn })],
  ['memory', async () => new MemoryLocalStore() as LocalStore],
] as const)('%s local store', (kind, open) => {
  test('reads back one scope, never another', async () => {
    const store = await open();
    expect(store.kind).toBe(kind);
    await seed(store);
    const rows = await store.rows('p:u1');
    expect({ ...rows.get('post') }).toEqual({
      p1: { id: 'p1', title: 'one' },
      p2: { id: 'p2', title: 'two' },
    });
    expect((await store.queue('p:u1'))?.nextSeq).toBe(4);
  });

  test('a delete removes one row, a put replaces it', async () => {
    const store = await open();
    await seed(store);
    await store.write(
      'p:u1',
      [{ type: 'post', key: 'p1', row: { id: 'p1', title: 'new' } }],
      [{ type: 'post', key: 'p2' }],
    );
    expect({ ...(await store.rows('p:u1')).get('post') }).toEqual({
      p1: { id: 'p1', title: 'new' },
    });
  });

  test('wipe takes one scope rows AND outbox, and leaves the other scope alone', async () => {
    const store = await open();
    await seed(store);
    await store.wipe('p:u1');
    expect((await store.rows('p:u1')).size).toBe(0);
    expect(await store.queue('p:u1')).toBeUndefined();
    expect({ ...(await store.rows('p:u2')).get('post') }).toEqual({ p9: { id: 'p9' } });
    expect((await store.queue('p:u2'))?.nextSeq).toBe(7);
  });

  test('wipeOthers keeps ONE scope, rows and outbox, and takes every other', async () => {
    const store = await open();
    await seed(store);
    await store.writeQueue('anon', { puts: [], deletes: [], nextSeq: 2 });
    await store.wipeOthers('p:u2');
    expect({ ...(await store.rows('p:u2')).get('post') }).toEqual({ p9: { id: 'p9' } });
    expect((await store.queue('p:u2'))?.nextSeq).toBe(7);
    expect((await store.rows('p:u1')).size).toBe(0);
    expect(await store.queue('p:u1')).toBeUndefined();
    expect(await store.queue('anon')).toBeUndefined();
  });
});

describe('openLocalStore', () => {
  test('a second open over the same disk sees what the first wrote — a reload', async () => {
    const disk = fakeIndexedDb();
    const first = await openLocalStore({ indexedDB: disk, warn: quiet().warn });
    await seed(first);
    const second = await openLocalStore({ indexedDB: disk, warn: quiet().warn });
    expect((await second.rows('p:u1')).get('post')?.['p1']).toEqual({ id: 'p1', title: 'one' });
  });

  test('blocked IndexedDB falls back to memory with exactly one X_LOCAL_STORE_UNAVAILABLE', async () => {
    const { warn, warned } = quiet();
    const store = await openLocalStore({ indexedDB: fakeIndexedDb({ blocked: true }), warn });
    expect(store.kind).toBe('memory');
    expect(warned.map((error) => error.code)).toEqual(['X_LOCAL_STORE_UNAVAILABLE']);
    // And it still works: the page does not break because it cannot remember.
    await seed(store);
    expect((await store.rows('p:u2')).size).toBe(1);
  });
});

describe('scopeKey', () => {
  test('unscoped persists nothing; anonymous and a principal named anon never collide', () => {
    expect(scopeKey(undefined)).toBeUndefined();
    expect(scopeKey(null)).toBe('anon');
    expect(scopeKey('anon')).not.toBe(scopeKey(null));
  });
});

// A quota refusal ABORTS the transaction and fires `abort` alone — no `complete`, no transaction
// `error`. `done(tx)` listened for the other two, so every write hung, and with it the outbox's
// `enqueue` and the persister's `flush`.
describe('a write the browser aborts', () => {
  test('rejects rather than hanging — rows and the outbox both', async () => {
    const knobs: FakeIdbOptions = {};
    const store = await openLocalStore({ indexedDB: fakeIndexedDb(knobs), warn: quiet().warn });
    knobs.quotaExceeded = true;
    const outcome = (pending: Promise<unknown>): Promise<string> =>
      Promise.race([
        pending.then(
          () => 'resolved',
          (error: unknown) => `rejected ${(error as { name?: string }).name}`,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 200)),
      ]);
    expect(
      await outcome(store.write('p:u1', [{ type: 'post', key: 'p1', row: { id: 'p1' } }], [])),
    ).toBe('rejected QuotaExceededError');
    expect(await outcome(store.writeQueue('p:u1', { puts: [], deletes: [], nextSeq: 2 }))).toBe(
      'rejected QuotaExceededError',
    );
  });
});
