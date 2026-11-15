// `'verify'`, the serving role's schema mode, through the real `startQueue` on embedded Postgres:
// the wait's deadline is read from the env the boot was HANDED, and the one statement that reads
// the framework stamp and the app's ledger together runs on a real server, ledger absent or not.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { ensureLedger, LEDGER_TABLE, raw, setDbClient } from '@ultimat3/db';
import { resetJobDriver } from '@ultimat3/jobs/adapter';
import { SCHEMA_WAIT_ENV } from './framework-schema-wait';
import { MIGRATIONS_DIR } from './migrations';
import { resolveServices } from './runtime-bindings';
import { type RunningQueue, startQueue } from './runtime-queue';

/** A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget. */
const BOOT_MS = 60_000;

let root = '';
let running: RunningQueue | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-verify-'));
  await Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'create table notes (id int);\n');
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetJobDriver();
  setDbClient(undefined);
}, BOOT_MS);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = async (work: Promise<RunningQueue>): Promise<UltimateError> => {
  try {
    running = await work;
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  return expect.unreachable('the boot was refused with a coded error');
};

describe('unit · the verify boot', () => {
  test(
    `${SCHEMA_WAIT_ENV} is read from the env the boot was handed, never process.env`,
    async () => {
      const handed = { [SCHEMA_WAIT_ENV]: 'soon' };
      expect(process.env[SCHEMA_WAIT_ENV]).toBeUndefined();
      const error = await refusal(
        startQueue(resolveServices(root, {}), undefined, handed, 'verify'),
      );
      expect(error.code).toBe('X_CONFIG_INVALID');
    },
    BOOT_MS,
  );

  test(
    'a database no migrate ever ran on, deadline 0: refused at once, the stamp read past the 42P01',
    async () => {
      const handed = { [SCHEMA_WAIT_ENV]: '0' };
      const error = await refusal(
        startQueue(resolveServices(root, {}), undefined, handed, 'verify'),
      );
      // The joint statement fails on the missing ledger on a real server; the stamp is then read
      // alone, so the refusal is the framework's, judged first — never a raw 42P01.
      expect(error.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
      expect(error.fix).toBe('x db migrate');
    },
    BOOT_MS,
  );

  test(
    'stamped, then the image ships a migration the ledger lacks — and then holds',
    async () => {
      const handed = { [SCHEMA_WAIT_ENV]: '0' };
      // The migrate step's half that stamps the framework schema, and nothing of the app's.
      running = await startQueue(resolveServices(root, {}), undefined, handed, 'apply');
      await running.stop();
      running = undefined;
      // No ledger yet: the one statement fails 42P01 on a real server, read as behind.
      const absent = await refusal(
        startQueue(resolveServices(root, {}), undefined, handed, 'verify'),
      );
      expect(absent.code).toBe('X_APP_MIGRATIONS_UNAPPLIED');
      expect(absent.meta?.['ledger']).toBe(false);
      // The ledger holding the shipped migration: served.
      running = await startQueue(resolveServices(root, {}), undefined, handed, 'apply');
      await ensureLedger(running.db);
      await running.db.execute(
        raw(
          `insert into ${LEDGER_TABLE} (id, name, checksum, app_version, duration_ms) values ('0001_init', 'init', 'x', 'test', 0)`,
        ),
      );
      await running.stop();
      running = await startQueue(resolveServices(root, {}), undefined, handed, 'verify');
      expect(running.db).toBeDefined();
    },
    BOOT_MS,
  );
});
