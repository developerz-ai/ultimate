// The queue installs two process-global accessors, so the only behaviour worth pinning here is
// that stopping it takes both back. A leaked `jobDriver()` is invisible until the NEXT command in
// the same process reuses it over a closed database and fails on a connection it never opened.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { setDbClient } from '@ultimat3/db';
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
});
