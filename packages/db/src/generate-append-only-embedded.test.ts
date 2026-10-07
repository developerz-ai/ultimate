// The same proof on the embedded PGlite — the dev database and every scratch replay — so the
// trigger `x db gen` writes is one both engines run, plpgsql included.

import { afterAll, describe, test } from 'bun:test';
import { proveAppendOnlyTrigger } from './generate-append-only-fixture';
import { pgliteClient } from './pglite';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 30_000;

describe('embedded · pglite · the append-only trigger', () => {
  const client = pgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'refuses raw UPDATE and DELETE, is seen by drift, and goes with appendOnly',
    async () => {
      await proveAppendOnlyTrigger(client, 'aot_ledger_embedded');
    },
    PGLITE_BOOT_MS,
  );
});
