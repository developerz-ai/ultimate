// `consumer()` refusals and identity `consumer.test.ts` does not reach: a missing `keys`/`open`/
// `handle` and a batch that is no whole positive count are refused where written; `isConsumer`
// tells a consumer from a plain job; and `enqueueMany` from outside a run enqueues, as a job's does.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type PgliteClient, pgliteClient, setDbClient } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { consumer } from './consumer';
import { isConsumer } from './consumer-registry';
import type { ConsumerDefinition } from './consumer-types';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';

let minted = 0;
function definition(
  overrides: Partial<ConsumerDefinition<number, number>> = {},
): ConsumerDefinition<number, number> {
  minted += 1;
  return {
    name: `decl-${minted}`,
    tenant: 'none',
    keys: () => ['acct-1'],
    open: async function* () {},
    handle: () => 0,
    cursor: { load: () => null, save: () => undefined },
    ...overrides,
  };
}

const refusal = (make: () => unknown): { code?: string; cause?: string } => {
  try {
    make();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`a non-coded throw: ${String(error)}`);
  }
  return expect.unreachable('the declaration was accepted');
};

let db: PgliteClient | undefined;
beforeEach(() => {
  db ??= pgliteClient();
  setDbClient(db);
});
afterEach(() => {
  resetJobsFacade();
  resetJobDriver();
  resetJobs();
  resetTasks();
});
afterAll(async () => {
  setDbClient(undefined);
  await db?.close();
});

describe('consumer() refuses', () => {
  for (const field of ['keys', 'open', 'handle'] as const) {
    test(`a declaration with no ${field}()`, () => {
      const refused = refusal(() =>
        consumer(definition({ [field]: undefined } as Partial<ConsumerDefinition<number, number>>)),
      );
      expect(refused.code).toBe('X_CONSUMER_INVALID');
      expect(refused.cause).toContain(`declares no ${field}()`);
    });
  }

  for (const batch of [0, 1.5, Number.NaN]) {
    test(`a batch of ${String(batch)}`, () => {
      const refused = refusal(() => consumer(definition({ batch })));
      expect(refused.code).toBe('X_CONSUMER_INVALID');
      expect(refused.cause).toContain(`declares batch ${String(batch)}`);
    });
  }
});

describe('a consumer handle', () => {
  test('isConsumer tells it from a plain job and from a value that is no handle', () => {
    const handle = consumer(definition());
    const plain = job<{ id: string }>({
      name: `decl-plain-${minted}`,
      input: t.object({ id: t.string }),
      tenant: 'none',
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1 },
      run: async () => undefined,
    });
    expect(isConsumer(handle)).toBe(true);
    expect(isConsumer(plain)).toBe(false);
    expect(isConsumer({ name: handle.name })).toBe(false);
  });

  test('enqueueMany from outside a run enqueues one row per key', async () => {
    const driver = memoryJobDriver();
    setJobDriver(driver);
    const handle = consumer(definition());
    const results = await handle.enqueueMany([{ key: 'a' }, { key: 'b' }]);
    expect(results.map((result) => result.deduped)).toEqual([false, false]);
    const rows = (await driver.introspect?.list({ limit: 10 })) ?? [];
    const keys = rows.map((row) => (row.input as { key: string }).key);
    expect(keys.sort()).toEqual(['a', 'b']);
  });
});
