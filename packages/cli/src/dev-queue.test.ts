// The queue installs two process-global accessors and every framework table this process owns, so
// two things are worth pinning: stopping it takes both accessors back, and `applySchema` really
// applied each table. A leaked `jobDriver()` is invisible until the NEXT command in the same
// process reuses it over a closed database; a missing table is invisible until the first request.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { raw, setDbClient } from '@ultimat3/db';
import { jobDriver, resetJobDriver } from '@ultimat3/jobs';
import type { RunningQueue } from './dev-queue';
import { startQueue } from './dev-queue';
import { resolveServices } from './dev-services';

const ROOT = `${import.meta.dir}/../.queue-fixture`;

/**
 * Booting embedded Postgres is seconds of real work, and bun's default budget is 5s — close
 * enough to it that a loaded machine, not the code, would decide this file. Explicit and generous
 * so a hang is reported as a hang.
 */
const BOOT_TIMEOUT_MS = 60_000;

let running: RunningQueue | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetJobDriver();
  setDbClient(undefined);
  await rm(ROOT, { recursive: true, force: true });
}, BOOT_TIMEOUT_MS);

describe('startQueue', () => {
  test(
    'installs the ambient job driver, then clears it on stop',
    async () => {
      const services = resolveServices(ROOT, {});
      const queue = await startQueue(services);
      running = queue;

      expect(jobDriver()).toBe(queue.jobs);

      await queue.stop();
      running = undefined;

      // The bug this pins: `stop()` used to clear only the database client, so the next command
      // saw a driver already installed, skipped queue startup, and queried a closed socket.
      expect(jobDriver()).toBeUndefined();
    },
    BOOT_TIMEOUT_MS,
  );

  // Asked of the DATABASE, never of the constant list `applySchema` iterates — a list this test
  // restated would pass on the day the boot stopped applying one of them. `x_rate_limit` is the
  // one that was missing: `postgresRateLimitStore` was installable through
  // `runtime.rateLimitStore` while nothing had ever created its relation, so the FIRST request a
  // shared-limit deployment served was the thing that discovered it.
  test(
    'applies every framework table the boot owns, x_rate_limit included',
    async () => {
      const queue = await startQueue(resolveServices(ROOT, {}));
      running = queue;

      const rows = await queue.db.query<{ readonly table_name: string }>(
        raw("select table_name from information_schema.tables where table_schema = 'public'"),
      );
      const tables = rows.map((row) => row.table_name);

      expect(tables).toContain('x_jobs');
      expect(tables).toContain('x_idempotency');
      expect(tables).toContain('x_rate_limit');
    },
    BOOT_TIMEOUT_MS,
  );
});
