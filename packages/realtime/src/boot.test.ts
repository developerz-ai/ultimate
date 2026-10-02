// The boot's wipe across a principal change: WHOSE disk is kept is decided at the wipe, from the
// principal the page has then — never from the one it had when the boot started.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { bootPage } from './boot';
import { resetPage } from './hooks-fixture';
import { type LocalStore, MemoryLocalStore } from './local-store-idb';

const DISK = Symbol.for('ultimate.local-store');

afterEach(() => {
  Reflect.deleteProperty(globalThis, DISK);
  resetPage();
  rescope(null);
});

const queued = (key: string) => ({
  puts: [
    {
      key,
      seq: 1,
      name: 'likePost',
      input: {},
      enqueuedAt: 0,
      attempts: 0,
      status: 'pending' as const,
      error: null,
    },
  ],
  deletes: [],
  nextSeq: 2,
});

describe('a principal change while the boot is opening the disk', () => {
  test("keeps the NEW principal's queue and wipes the one that left", async () => {
    const disk = new MemoryLocalStore();
    await disk.writeQueue('p:u1', queued('u1-like'));
    await disk.writeQueue('p:u2', queued('u2-like'));
    // The page's one store, still opening: the boot parks on it before it wipes anything.
    let opened: (store: LocalStore) => void = () => undefined;
    Object.defineProperty(globalThis, DISK, {
      value: new Promise<LocalStore>((resolve) => {
        opened = resolve;
      }),
      configurable: true,
    });
    rescope('u1');

    const booted = bootPage();
    rescope('u2');
    opened(disk);
    await booted;

    expect((await disk.queue('p:u2'))?.mutations.map((m) => m.key)).toEqual(['u2-like']);
    expect(await disk.queue('p:u1')).toBeUndefined();
  });

  test('a boot handed its scope explicitly still keeps exactly that one', async () => {
    const disk = new MemoryLocalStore();
    await disk.writeQueue('p:u1', queued('u1-like'));
    await disk.writeQueue('p:u2', queued('u2-like'));
    Object.defineProperty(globalThis, DISK, { value: Promise.resolve(disk), configurable: true });
    rescope('u1');
    await bootPage({ principal: 'u1' });
    expect((await disk.queue('p:u1'))?.mutations.map((m) => m.key)).toEqual(['u1-like']);
    expect(await disk.queue('p:u2')).toBeUndefined();
  });
});
