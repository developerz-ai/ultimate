// Which store the handle reads: memory under `bun test`, the process's Postgres client
// everywhere else. A handle that silently took the memory driver in a container would serve an
// empty database with a green gate.
import { recordingClient, setDbClient } from '@ultimat3/db';
import { expect, unitTest } from '@ultimat3/testing';
import { db, driver, selectDriver } from './client';

unitTest('docs-site reads memory under test and Postgres everywhere else', () => {
  // Only the in-memory driver can empty itself — a Postgres driver that could truncate an app's
  // rows from a test eventually would — so `reset` is what tells the two apart.
  expect(selectDriver({ NODE_ENV: 'test' }).reset).toBeDefined();
  expect(selectDriver({ NODE_ENV: 'production' }).reset).toBeUndefined();
  expect(selectDriver({ ULTIMATE_ENV: 'development' }).reset).toBeUndefined();
});

unitTest('the handle is built over the driver this module exports', () => {
  expect(driver.reset).toBeDefined();
  expect(typeof db).toBe('object');
});

// The test driver decides per call: a migrated database installed with `setDbClient` is what
// `db` reaches, and clearing it hands the handle back to memory.
unitTest('under test the handle follows an installed client', async () => {
  const client = recordingClient();
  setDbClient(client);
  try {
    await driver.transactor().run(async () => undefined);
  } finally {
    setDbClient(undefined);
  }
  expect(client.texts).toContain('BEGIN');
});
