// The ISR store conformance suite over the memory store and the storage-backed one (over the memory
// disk), and the proof it can fail: a store whose markStale re-generates the page, and one whose
// fence takes every write.

import { describe, expect, test } from 'bun:test';
import type { IsrStore } from '@ultimat3/render/server';
import { memoryIsrStore, storageIsrStore } from '@ultimat3/render/server';
import { memoryStorageDriver } from '@ultimat3/storage';
import { ISR_STORE_CHECKS, isrStoreConformance } from './isr-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory ISR store'), () => {
  behavesLike(isrStoreConformance, () => memoryIsrStore());
});

describe(testName('unit', 'the storage-backed ISR store, over the memory disk'), () => {
  behavesLike(isrStoreConformance, () => storageIsrStore({ disk: memoryStorageDriver() }));
});

const check = (name: string) => {
  const found = ISR_STORE_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a store that breaks the contract fails conformance'), () => {
  test('a markStale that answers true for a page it never held', async () => {
    const inner = memoryIsrStore();
    const eager: IsrStore = { ...inner, markStale: () => true };
    const stale = check('markStale marks a held page');
    await expect(stale.run(eager)).rejects.toThrow();
    await stale.run(memoryIsrStore());
  });

  test('a fence whose setIfCurrent never compares the reading', async () => {
    const inner = memoryIsrStore();
    const open: IsrStore = {
      ...inner,
      tagFence: {
        ...inner.tagFence,
        setIfCurrent: (entry) => {
          inner.set(entry);
          return true;
        },
      },
    };
    const fenced = check('a tag fence refuses');
    await expect(fenced.run(open)).rejects.toThrow();
    await fenced.run(memoryIsrStore());
  });

  test('every check has a name of its own', () => {
    const names = ISR_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
