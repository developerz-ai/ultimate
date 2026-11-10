// The failure-store suite over a memory reference store (core ships none: the boot's is Postgres)
// with a failing request's transaction on the embedded Postgres, and the proof it can fail: a store
// whose second save of one id overwrites the first.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FailureBundle, FailureStore } from '@ultimat3/core/adapter';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw } from '@ultimat3/db';
import type { FailureStoreSubject } from './failure-store-conformance';
import { FAILURE_STORE_CHECKS, failureStoreConformance } from './failure-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

let client: PgliteClient;

// `pgliteClient()` boots on its first statement: paid here, inside the hook's budget.
beforeAll(async () => {
  client = pgliteClient();
  await client.execute(raw('select 1'));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

/** The reference: one Map, first save wins, held as a copy so a caller's later edit is not kept. */
function memorySubject(firstWins = true): FailureStoreSubject {
  const bundles = new Map<string, FailureBundle>();
  const store: FailureStore = {
    async save(bundle) {
      if (firstWins && bundles.has(bundle.id)) return;
      bundles.set(bundle.id, structuredClone(bundle));
    },
  };
  return {
    store,
    find: async (id) => bundles.get(id),
    get client() {
      return client;
    },
  };
}

describe(testName('unit', 'a memory failure store'), () => {
  behavesLike(failureStoreConformance, () => memorySubject());
});

describe(testName('unit', 'a failure store that breaks the contract fails conformance'), () => {
  test('a second save of one id that overwrites the first', async () => {
    const once = FAILURE_STORE_CHECKS.find((each) => each.name.startsWith('saving one id twice'));
    if (once === undefined) return expect.unreachable('no conformance check for a second save');
    await expect(once.run(memorySubject(false))).rejects.toThrow();
    await once.run(memorySubject());
  });

  test('every check has a name of its own', () => {
    const names = FAILURE_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
