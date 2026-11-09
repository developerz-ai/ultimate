// The kit's refusals carry what a caller branches on — the capability in `meta` — and a store's
// duplicate key is the code Postgres' `23505` becomes, without pretending a server said `23505`.

import { afterAll, afterEach, expect, test } from 'bun:test';
import { sqlState } from '@ultimat3/db';
import * as adapter from '@ultimat3/entity/adapter';
import { text, uuid } from './columns';
import { defineDriver } from './define-driver';
import { driverUnsupported, entityUniqueViolation } from './driver-errors';
import { clearDriverStores, driverStores } from './driver-registry';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});
afterEach(() => clearDriverStores());

const tags = entity('driver_errors_tags', {
  columns: { id: uuid().primaryKey(), label: text({ max: 20 }) },
});

test('a duplicate key is X_DB_UNIQUE_VIOLATION naming the constraint, with no SQLSTATE', () => {
  const error = entityUniqueViolation(tags, 'driver_errors_tags_pkey');
  expect(error.code).toBe('X_DB_UNIQUE_VIOLATION');
  expect(error.meta?.['constraint']).toBe('driver_errors_tags_pkey');
  expect(sqlState(error)).toBeUndefined();
});

test('X_DRIVER_UNSUPPORTED names the capability, the driver and the call', () => {
  const error = driverUnsupported('mongo', 'tags', 'upsertAll', 'upsert');
  expect(error.code).toBe('X_DRIVER_UNSUPPORTED');
  expect(error.meta).toEqual({
    capability: 'upsert',
    driver: 'mongo',
    entity: 'tags',
    operation: 'upsertAll',
  });
  expect(
    error.fix.startsWith('defineDriver({ name: "mongo", capabilities: [..., \'upsert\']'),
  ).toBe(true);
});

test('declaring transactions with no transactor is refused when the driver is defined', () => {
  let code = 'no throw';
  try {
    defineDriver({
      name: 'half',
      capabilities: ['transactions'],
      repo: () => {
        throw driverUnsupported('half', 'tags', 'repo', 'transactions');
      },
    });
  } catch (error) {
    code = error instanceof adapter.DriverError ? error.code : 'other';
  }
  expect(code).toBe('X_DRIVER_CAPABILITY_MISSING');
});

test('a defined driver is noted as a custom store; the subpath exports the kit', () => {
  adapter.defineDriver({ name: 'kv', capabilities: [], repo: () => ({}) as never });
  expect(driverStores()).toEqual({ sql: [], custom: ['kv'] });
  for (const name of ['readPlan', 'idPlan', 'cursorFor', 'seekFrom', 'selectRows', 'narrowRow']) {
    expect(typeof (adapter as Record<string, unknown>)[name]).toBe('function');
  }
});
