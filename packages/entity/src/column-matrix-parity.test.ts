// Every column kind and every `arrayOf()` element kind, round-tripped through `postgresDriver()`
// over PGlite and compared with `memoryDriver()` — the embedded half of the matrix
// `column-matrix.live.test.ts` runs on `Bun.SQL`. The two drivers decode a cell by different
// tables (PGlite parses `uuid[]`, `Bun.SQL` hands back its literal), so green here says nothing
// about a server and green there says nothing about `x dev`: both are the bar.

import { afterAll, beforeAll, describe } from 'bun:test';
import { pgliteClient, setDbClient } from '@ultimat3/db';
import { columnMatrixCases, createMatrixTable } from './column-matrix-fixture';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  await createMatrixTable(client);
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

describe('pglite · every column kind round-trips', () => {
  columnMatrixCases(() => postgresDriver());
});
