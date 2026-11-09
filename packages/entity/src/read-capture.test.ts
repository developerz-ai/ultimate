// The read half of failure capture: a row a repository answered lands in the open buffer, a sealed
// column never does, a secret-named one is masked, and with no captured call open nothing records.

import { afterAll, afterEach, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import {
  reportError,
  settleFailureCaptures,
  UltimateError,
  withFailureCapture,
} from '@ultimat3/core';
import { installFailureStore } from '@ultimat3/core/adapter';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';

const vaults = entity('rc_vaults', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    apiKey: text(),
    secret: text().sealed(),
  },
});

afterAll(() => clearRegistry());
let releaseStore: () => void = () => undefined;
afterEach(() => releaseStore());

/** Every capture below saves into its own list; the previous test's store is released first. */
const useStore = (saved: FailureBundle[]): void => {
  releaseStore();
  releaseStore = installFailureStore({ save: async (bundle) => void saved.push(bundle) });
};

const captured = async (read: () => Promise<unknown>): Promise<FailureBundle[]> => {
  const saved: FailureBundle[] = [];
  useStore(saved);
  try {
    await withFailureCapture(
      'action',
      'openVault',
      () => 500,
      async () => {
        await read();
        throw new UltimateError({ code: 'X_BOOM', cause: 'planted', fix: 'x verify' });
      },
    );
  } catch (error) {
    reportError(error, { source: 'http' });
  }
  await settleFailureCaptures();
  return saved;
};

test('rows a read answered are captured; sealed absent, secret-named masked', async () => {
  const table = database({ vaults }, { driver: memoryDriver() }).vaults;
  const made = await table.insert({ name: 'Ada', apiKey: 'k-planted', secret: 'hunter2' });
  const [bundle] = await captured(async () => {
    await table.where({ id: made.id }).one();
    await table.all();
  });
  expect(bundle?.reads).toEqual([
    {
      entity: 'rc_vaults',
      row: { id: made.id, name: 'Ada', apiKey: '[redacted]' },
      masked: ['apiKey'],
    },
    {
      entity: 'rc_vaults',
      row: { id: made.id, name: 'Ada', apiKey: '[redacted]' },
      masked: ['apiKey'],
    },
  ]);
  const bytes = JSON.stringify(bundle);
  expect(bytes).not.toContain('hunter2');
  expect(bytes).not.toContain('k-planted');
});

test('a read outside a captured call records nothing', async () => {
  const table = database({ vaults }, { driver: memoryDriver() }).vaults;
  await table.insert({ name: 'Bo', apiKey: 'k', secret: 's' });
  const saved: FailureBundle[] = [];
  useStore(saved);
  await table.all();
  await settleFailureCaptures();
  expect(saved).toEqual([]);
});
