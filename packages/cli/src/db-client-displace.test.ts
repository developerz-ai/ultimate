// A command that installs its own `db()` gives the process back what it found: an installed client
// is put back untouched, a lazily built default it dropped is closed — never orphaned, never kept.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  ambientClient,
  baseClient,
  type DbClient,
  dbClientInstalled,
  setDbClient,
} from '@ultimat3/db';
import { displaceAmbient } from './db-client-displace';

afterEach(() => setDbClient(undefined));

const closable = (log: string[]): DbClient =>
  ({
    close: () => {
      log.push('closed');
      return Promise.resolve();
    },
  }) as unknown as DbClient;

describe('unit · the db() a command displaces', () => {
  test('an installed client is put back, and not closed', async () => {
    const log: string[] = [];
    const installed = closable(log);
    setDbClient(installed);
    const restore = displaceAmbient();
    setDbClient({} as DbClient);
    await restore();
    expect(ambientClient()).toBe(installed);
    expect(dbClientInstalled()).toBe(true);
    expect(log).toEqual([]);
  });

  test('a lazily built default it dropped is closed, and db() is lazy again', async () => {
    const lazy = baseClient() as DbClient & { close(): Promise<void> };
    const log: string[] = [];
    const close = lazy.close.bind(lazy);
    lazy.close = () => {
      log.push('closed');
      return close();
    };
    const restore = displaceAmbient();
    setDbClient({} as DbClient);
    await restore();
    expect(log).toEqual(['closed']);
    expect(ambientClient()).toBeUndefined();
    expect(dbClientInstalled()).toBe(false);
  });

  test('nothing there: nothing is closed, and db() is lazy again', async () => {
    const restore = displaceAmbient();
    setDbClient({} as DbClient);
    await restore();
    expect(ambientClient()).toBeUndefined();
    expect(dbClientInstalled()).toBe(false);
  });
});
