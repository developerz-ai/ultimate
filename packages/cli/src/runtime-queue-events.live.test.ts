// An answer belongs to the unit of work that gave it. The boot's bus used to take the pool beside
// the outbox that takes `currentTx()`, so `publishEvent` inside a transaction that rolled back still
// resumed the run waiting on it: an approval the business rule refused paid the invoice.
//
// A real server, and only a real server: on the embedded single-session database a pooled statement
// runs inside the open transaction anyway, so this could not fail there. Skips unless
// `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file creates and drops a database.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { assert, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import { withTransaction } from '@ultimat3/db';
import { eventBus, publishEvent } from '@ultimat3/jobs';
import { resolveServices } from './runtime-bindings';
import type { RunningQueue } from './runtime-queue';
import { startQueue } from './runtime-queue';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BOOT_TIMEOUT_MS = 60_000;
/** Its own database, because the boot applies DDL to it. Never the one `TEST_DATABASE_URL` names. */
const PROBE_DB = probeDatabaseName('x_event_tx_probe');

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const admin = async (statement: string, values: readonly unknown[] = []): Promise<unknown[]> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    return [...(await sql.unsafe(statement, [...values]))];
  } finally {
    await sql.end();
  }
};

const adminExecutor = {
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    (await admin(text, values)) as R[],
};

/** What the business rule throws to refuse: input to the rollback, never the test's verdict. */
class Refused extends TypeError {}

describeLive('live · postgres · a published event lives and dies with its transaction', () => {
  let root: string;
  let queue: RunningQueue | undefined;

  const events = (): RunningQueue['events'] => {
    assert(queue !== undefined, 'the queue did not boot', 'read the beforeAll failure above');
    return queue.events;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'x-event-tx-'));
    await admin(`drop database if exists ${PROBE_DB} with (force)`);
    await sweepProbeDatabases(adminExecutor, PROBE_DB);
    await admin(`create database ${PROBE_DB}`);
  }, BOOT_TIMEOUT_MS);

  // Per test: the preload hands every ambient accessor back between tests, the bus among them.
  beforeEach(async () => {
    const services = resolveServices(root, { DATABASE_URL: probeUrl() });
    queue = await startQueue(services, undefined, {}, 'apply');
    expect(eventBus()).toBe(queue.events);
  }, BOOT_TIMEOUT_MS);

  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await admin(`drop database if exists ${PROBE_DB} with (force)`);
  }, BOOT_TIMEOUT_MS);

  test('a publish inside a rolled-back transaction answers no waiter', async () => {
    const refused = new Refused('the business rule refused');
    await expect(
      withTransaction(async () => {
        await publishEvent('invoice.refused', { by: 'ada' });
        throw refused;
      }),
    ).rejects.toBe(refused);

    expect(await events().find('invoice.refused', undefined, 0)).toBeUndefined();
  });

  test('a publish inside a committed transaction does', async () => {
    await withTransaction(async () => {
      await publishEvent('invoice.approved', { by: 'ada' });
    });
    expect((await events().find('invoice.approved', undefined, 0))?.payload).toEqual({ by: 'ada' });
  });

  test('a publish with no transaction open still lands', async () => {
    await publishEvent('invoice.direct', { by: 'ada' });
    expect((await events().find('invoice.direct', undefined, 0))?.payload).toEqual({ by: 'ada' });
  });
});
