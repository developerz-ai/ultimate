// Which store the handle reads: memory under `bun test`, the process's Postgres client
// everywhere else. A handle that silently took the memory driver in a container would serve an
// empty database with a green gate.
import { ctxOf, runWithContext } from '@ultimat3/core';
import { recordingClient, setDbClient } from '@ultimat3/db';
import { testActor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { db, driver, selectDriver } from './client';

unitTest('docs-site reads memory under test and Postgres everywhere else', () => {
  // Only the in-memory driver can empty itself — a Postgres driver that could truncate an app's
  // rows from a test eventually would — so `reset` is what tells the two apart.
  expect(selectDriver({ NODE_ENV: 'test' }).reset).toBeDefined();
  expect(selectDriver({ NODE_ENV: 'production' }).reset).toBeUndefined();
  expect(selectDriver({ ULTIMATE_ENV: 'development' }).reset).toBeUndefined();
});

// Every table on `db` reads through `driver`: a client installed under it sees each table's
// statement. `database(entities)` with no driver takes the process default — memory — and would
// answer every test from rows no migration made while this file stayed green. The reads run as an
// actor because a tenant table refuses one with no org to scope it (`X_TENANCY_UNSCOPED`).
unitTest('the handle is built over the driver this module exports', async () => {
  expect(driver.reset).toBeDefined();
  const tables: readonly { all(): Promise<readonly unknown[]> }[] = Object.values(db);
  const { actor } = testActor('client-test', { orgId: '00000000-0000-4000-8000-000000000001' });
  const client = recordingClient();
  setDbClient(client);
  try {
    await runWithContext(ctxOf({ actor }), async () => {
      for (const table of tables) {
        const before = client.statements.length;
        await table.all();
        expect(client.statements.length).toBeGreaterThan(before);
      }
    });
  } finally {
    setDbClient(undefined);
  }
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
