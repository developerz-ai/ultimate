// `notifyStores` with zero config: a booted app has a database, so the boot's delivery ledger is
// Postgres over that pool — never the memory ledger notify refuses outside development and test.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresDeliveryLedger } from '@ultimat3/notify';
import { memoryDeliveryLedger, memoryInboxStore } from '@ultimat3/notify';
import type { DeliveryLedger } from '@ultimat3/notify/adapter';
import { notifyStoresWithLedger } from './runtime-port-bindings';

/** An executor that records each statement and answers no rows. */
const recording = () => {
  const statements: string[] = [];
  const executor: PgExecutor = {
    query: async <R>(text: string): Promise<readonly R[]> => {
      statements.push(text);
      return [];
    },
  };
  return { executor, statements };
};

/** The Postgres ledger's wider type is the one carrying the sweep. */
const isPostgresLedger = (ledger: DeliveryLedger): ledger is PostgresDeliveryLedger =>
  'purgeExpired' in ledger;

describe('unit · the boot delivery ledger', () => {
  test('runtime.ts silent: the ledger is Postgres over the boot pool', async () => {
    const { executor, statements } = recording();
    const stores = notifyStoresWithLedger(undefined, executor);
    const ledger = stores.ledger;
    if (ledger === undefined || !isPostgresLedger(ledger)) {
      return expect.unreachable('the boot ledger is not the Postgres one');
    }
    await ledger.purgeExpired(Date.now());
    expect(statements.some((sql) => sql.includes('x_notify_deliveries'))).toBe(true);
  });

  test("an app's own ledger is kept, untouched", () => {
    const ledger = memoryDeliveryLedger();
    const inbox = memoryInboxStore();
    const stores = notifyStoresWithLedger({ ledger, inbox }, recording().executor);
    expect(stores.ledger).toBe(ledger);
    expect(stores.inbox).toBe(inbox);
  });

  test('stores supplied without a ledger keep theirs and gain the Postgres one', () => {
    const inbox = memoryInboxStore();
    const stores = notifyStoresWithLedger({ inbox }, recording().executor);
    expect(stores.inbox).toBe(inbox);
    expect(stores.ledger).toBeDefined();
    expect(stores.preferences).toBeUndefined();
    expect(stores.digest).toBeUndefined();
  });
});
