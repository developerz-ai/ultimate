// The partitioning proof on the embedded PGlite — the dev database and every drift replay — so the
// function `x db gen` writes is one both engines run, plpgsql included.

import { afterAll, describe, test } from 'bun:test';
import { proveBackfillFrom, provePartitioning } from './generate-partition-fixture';
import { pgliteClient } from './pglite';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 30_000;

describe('embedded · pglite · entity({ partitionBy })', () => {
  const client = pgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'monthly partitions are created, an insert routes, retention drops a partition',
    async () => {
      await provePartitioning(client, 'gp_events_embedded');
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a backfill target gets every partition back to its oldest row (from)',
    async () => {
      await proveBackfillFrom(client, 'gp_back_embedded');
    },
    PGLITE_BOOT_MS,
  );
});
