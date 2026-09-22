import { afterEach, describe, expect, test } from 'bun:test';
import type { RecordRows, Row } from '@ultimat3/core';
import { rescope, UltimateError } from '@ultimat3/core';
import { MemoryLocalStore } from './local-store-idb';
import type { PersistableStore } from './record-persister';
import { persistedTypes, recordPersister } from './record-persister';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  Reflect.deleteProperty(globalThis, 'document');
});

/** The two halves of the store the persister reads: synced truth, and change notifications. */
function fakeStore(): PersistableStore & {
  set(type: string, key: string, row: Row | undefined): void;
  restored: [string, RecordRows][];
} {
  const synced = new Map<string, Row>();
  const listeners = new Set<(changed: ReadonlySet<string>) => void>();
  const restored: [string, RecordRows][] = [];
  return {
    restored,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    synced: (type, key) => synced.get(`${type}:${key}`),
    restore: (type, rows) => void restored.push([type, rows]),
    set(type, key, row) {
      if (row === undefined) synced.delete(`${type}:${key}`);
      else synced.set(`${type}:${key}`, row);
      for (const listener of listeners) listener(new Set([`${type}:${key}`]));
    },
  };
}

/** A manual clock for the debounce: nothing flushes until the test says so. */
function manualTimer(): { schedule: (fn: () => void) => () => void; fire(): void } {
  let armed: (() => void) | undefined;
  return {
    schedule: (fn) => {
      armed = fn;
      return () => (armed = undefined);
    },
    fire: () => armed?.(),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(principal: string | null | undefined) {
  const store = fakeStore();
  const local = new MemoryLocalStore();
  const timer = manualTimer();
  let leave: () => void = () => {};
  const persister = recordPersister({
    store,
    local,
    types: new Set(['post']),
    principal: () => principal,
    schedule: timer.schedule,
    onLeave: (flush) => {
      leave = flush;
      return () => {};
    },
  });
  return { store, local, timer, persister, leave: () => leave() };
}

describe('recordPersister', () => {
  test('a debounce that is not a whole number of ms, at least 1, is refused at construction', () => {
    for (const debounceMs of [Number.NaN, 0, -5]) {
      expect(() =>
        recordPersister({
          store: { subscribe: () => () => {}, synced: () => undefined, restore: () => {} },
          local: new MemoryLocalStore(),
          types: new Set(['post']),
          debounceMs,
          onLeave: () => () => {},
        }),
      ).toThrow(UltimateError);
    }
  });

  test('writes persisted types after the debounce, one write for many changes', async () => {
    const { store, local, timer } = setup('u1');
    store.set('post', 'p1', { id: 'p1', v: 1 });
    store.set('post', 'p1', { id: 'p1', v: 2 });
    expect((await local.rows('p:u1')).size).toBe(0);
    timer.fire();
    await settle();
    expect({ ...(await local.rows('p:u1')).get('post') }).toEqual({ p1: { id: 'p1', v: 2 } });
  });

  test('a type that is not persisted is never written', async () => {
    const { store, local, persister } = setup('u1');
    store.set('comment', 'c1', { id: 'c1' });
    await persister.flush();
    expect((await local.rows('p:u1')).size).toBe(0);
  });

  test('a row the server removed is removed from disk too', async () => {
    const { store, local, persister } = setup('u1');
    store.set('post', 'p1', { id: 'p1' });
    await persister.flush();
    store.set('post', 'p1', undefined);
    await persister.flush();
    expect((await local.rows('p:u1')).size).toBe(0);
  });

  test('leaving the page flushes without waiting for the debounce', async () => {
    const { store, local, leave } = setup('u1');
    store.set('post', 'p1', { id: 'p1' });
    leave();
    await settle();
    expect((await local.rows('p:u1')).get('post')?.['p1']).toEqual({ id: 'p1' });
  });

  test('restore hands back only persisted types of this principal', async () => {
    const { store, local, persister } = setup('u1');
    await local.write('p:u1', [{ type: 'post', key: 'p1', row: { id: 'p1' } }], []);
    await local.write('p:u1', [{ type: 'comment', key: 'c1', row: { id: 'c1' } }], []);
    await local.write('p:u2', [{ type: 'post', key: 'p9', row: { id: 'p9' } }], []);
    expect(await persister.restore()).toBe(1);
    expect(store.restored.map(([type, rows]) => [type, { ...rows }])).toEqual([
      ['post', { p1: { id: 'p1' } }],
    ]);
  });

  test('an unscoped page persists nothing and restores nothing', async () => {
    const { store, local, persister } = setup(undefined);
    await local.write('anon', [{ type: 'post', key: 'p1', row: { id: 'p1' } }], []);
    store.set('post', 'p2', { id: 'p2' });
    await persister.flush();
    expect(await persister.restore()).toBe(0);
    expect((await local.rows('anon')).get('post')?.['p2']).toBeUndefined();
  });

  test("a principal change wipes the previous principal's rows from disk", async () => {
    const store = fakeStore();
    const local = new MemoryLocalStore();
    recordPersister({ store, local, types: new Set(['post']), onLeave: () => () => {} });
    rescope('u1');
    await local.write('p:u1', [{ type: 'post', key: 'p1', row: { id: 'p1' } }], []);
    rescope('u2');
    await settle();
    expect((await local.rows('p:u1')).size).toBe(0);
  });
});

describe('persistedTypes', () => {
  test('reads the comma list the server rendered, and nothing without it', () => {
    expect(persistedTypes().size).toBe(0);
    Reflect.set(globalThis, 'document', {
      querySelector: (selector: string) =>
        selector === 'meta[name="ultimate-persist"]' ? { content: 'post, comment' } : null,
    });
    expect([...persistedTypes()]).toEqual(['post', 'comment']);
  });
});
