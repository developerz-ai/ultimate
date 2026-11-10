// `ledger()` against a real Postgres through `entityLedgerBook`: the lines land in the app's own
// table in ONE statement, a second run of the same posting writes nothing, two concurrent runs of
// one key still store it once, and a refused posting leaves the table empty. Skips unless
// `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, probeDatabaseName, sweepProbeDatabases, userActor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, generateMigration, postgresClient, raw, statementsOf } from '@ultimat3/db';
import { clearRegistry, entity, integer, money, postgresDriver, text } from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { LedgerPosting } from './ledger';
import { ledger } from './ledger';
import { entityLedgerBook } from './ledger-book';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_ledger_live');

const lines = entity('ledger_live_lines', {
  columns: { postingKey: text(), line: integer(), account: text(), amount: money() },
  primaryKey: ['postingKey', 'line'],
});

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

afterAll(() => {
  clearRegistry();
  resetJobs();
});

describe.skipIf(!hasPostgres)('live · postgres · ledger()', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 4 } });
    const { up } = generateMigration({ entities: [lines.$describe()], name: 'ledger lines' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  beforeEach(async () => {
    await client.execute(raw('delete from ledger_live_lines'));
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const run = async (handle: AnyJobHandle, posting: LedgerPosting) => {
    const driver = memoryJobDriver();
    await driver.enqueue({
      name: handle.name,
      queue: handle.queue,
      input: posting,
      idempotencyKey: posting.key,
      maxAttempts: 1,
    });
    const [claimed] = await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
    return executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx });
  };

  const stored = async () =>
    client.query<{ account: string; minor: string; currency: string }>(
      raw(
        'select account, amount_minor::text as minor, amount_currency as currency from ledger_live_lines order by line',
      ),
    );

  const posting: LedgerPosting = {
    key: 'pay_live_1',
    entries: [
      { account: 'cash', amount: { minor: 1299, currency: 'EUR' } },
      { account: 'revenue', amount: { minor: -1299, currency: 'EUR' } },
    ],
  };

  test('a posting lands once in the app table, however often or concurrently it runs', async () => {
    const book = () => entityLedgerBook({ driver: postgresDriver({ client }), entity: lines });
    const post = ledger({ name: 'ledger-live', tenant: 'none', book }) as AnyJobHandle;
    const [a, b] = await Promise.all([run(post, posting), run(post, posting)]);
    expect([a.outcome, b.outcome]).toEqual(['completed', 'completed']);
    const again = await run(post, posting);
    expect(again.result).toEqual({ key: 'pay_live_1', lines: 2, written: 0 });
    expect(await stored()).toEqual([
      { account: 'cash', minor: '1299', currency: 'EUR' },
      { account: 'revenue', minor: '-1299', currency: 'EUR' },
    ]);
  });

  test('a key re-used with other entries is refused and writes no line', async () => {
    const book = () => entityLedgerBook({ driver: postgresDriver({ client }), entity: lines });
    const post = ledger({ name: 'ledger-live-reused', tenant: 'none', book }) as AnyJobHandle;
    expect((await run(post, posting)).outcome).toBe('completed');
    const longer = await run(post, {
      key: posting.key,
      entries: [
        ...posting.entries,
        { account: 'vat', amount: { minor: 200, currency: 'EUR' } },
        { account: 'cash', amount: { minor: -200, currency: 'EUR' } },
      ],
    });
    expect(longer.code).toBe('X_LEDGER_POSTING_CONFLICT');
    const moved = await run(post, {
      key: posting.key,
      entries: [
        { account: 'cash', amount: { minor: 1299, currency: 'EUR' } },
        { account: 'other', amount: { minor: -1299, currency: 'EUR' } },
      ],
    });
    expect(moved.code).toBe('X_LEDGER_POSTING_CONFLICT');
    expect(await stored()).toEqual([
      { account: 'cash', minor: '1299', currency: 'EUR' },
      { account: 'revenue', minor: '-1299', currency: 'EUR' },
    ]);
  });

  test('an unbalanced posting writes no line', async () => {
    const book = () => entityLedgerBook({ driver: postgresDriver({ client }), entity: lines });
    const post = ledger({ name: 'ledger-live-unbalanced', tenant: 'none', book }) as AnyJobHandle;
    const execution = await run(post, {
      key: 'pay_live_2',
      entries: [
        { account: 'cash', amount: { minor: 1299, currency: 'EUR' } },
        { account: 'revenue', amount: { minor: -1200, currency: 'EUR' } },
      ],
    });
    expect(execution.code).toBe('X_LEDGER_UNBALANCED');
    expect(await stored()).toEqual([]);
  });
});
