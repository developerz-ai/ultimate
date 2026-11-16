// The entity driver suite on PGlite, cut into parts: each `entity-driver-conformance-pglite*` file
// boots its own embedded Postgres and runs every `PGLITE_PARTS`-th check, so test workers run the
// parts side by side. Round-robin over `ENTITY_DRIVER_CHECKS`: a new check lands in a part unasked.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { type DbClient, pgliteClient, setDbClient } from '@ultimat3/db';
import { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
import { sqlSubject } from './entity-conformance-sql-fixture';
import { type EntityDriverSubject, runEntityDriverCheck } from './entity-driver-conformance';
import { behavesLike, sharedExamples } from './shared-examples';
import { testName } from './test-types';

/** How many files the checks are dealt across; each must call `pgliteConformancePart(i)` once. */
export const PGLITE_PARTS = 3;

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
export const PGLITE_BOOT_MS = 30_000;

/** `entityDriverConformance`'s own per-check ceiling: one check writes 40,000 rows. */
const CHECK_TIMEOUT_MS = 60_000;

/** The checks part `part` runs: every `PGLITE_PARTS`-th, starting at `part`. */
export const checksOfPart = (part: number): typeof ENTITY_DRIVER_CHECKS =>
  ENTITY_DRIVER_CHECKS.filter((_, index) => index % PGLITE_PARTS === part);

/**
 * Boots a PGlite for this file (`pg_trgm`: the `contains` checks migrate a `gin_trgm_ops` index,
 * which needs it linked at boot), installs it as the db client for the whole file, and declares
 * part `part` of the suite against it — the block `entityDriverConformance` declares. Module scope.
 */
export function pgliteConformancePart(part: number): DbClient {
  const client = pgliteClient({ extensions: ['pg_trgm'] });
  beforeAll(() => {
    setDbClient(client);
  }, PGLITE_BOOT_MS);
  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });
  describe(testName('unit', 'the postgres entity driver on PGlite'), () => {
    behavesLike(
      sharedExamples('an entity driver', (subject: () => EntityDriverSubject) => {
        for (const check of checksOfPart(part)) {
          test(check.name, () => runEntityDriverCheck(check, subject()), CHECK_TIMEOUT_MS);
        }
      }),
      () => sqlSubject(() => client),
    );
  });
  return client;
}
