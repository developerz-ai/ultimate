// A stage `NOTIFY_STAGED` silences, against a real server. The silence is decided when the row is
// STAGED, but the relay can only find it once it COMMITS: a request transaction that staged
// behind an unclaimed row and committed after the relay had claimed that row and gone to rest
// left its own row unpublished for the whole rest (`IDLE_REST_MAX_MS`). The silenced stage now
// holds `OUTBOX_STAGING_LOCK` until it commits, and an idle claim reports it, so the relay keeps
// polling instead of resting. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases, uuidV7 } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { SQL_JOBS_TABLE, SQL_OUTBOX_STAGE } from './driver-pg-sql';
import type { OutboxRecord } from './outbox';
import { postgresOutboxStore } from './outbox-pg';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_outbox_staged_silent');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const record = (item: string): OutboxRecord => ({
  id: uuidV7(),
  runId: uuidV7(),
  job: 'silentProbe',
  queue: 'default',
  input: { item },
  idempotencyKey: `silent:${item}`,
  maxAttempts: 1,
  // The test preload freezes this process's `Date`; the server's clock is real.
  runAt: 1,
  stagedAt: 1,
});

describe.skipIf(!hasPostgres)('live · postgres · a stage the outbox wake silenced', () => {
  let admin: PostgresClient;
  let relayPod: PostgresClient;
  let webPod: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    relayPod = postgresClient({ url: probeUrl(), role: 'worker', profile: { max: 1 } });
    webPod = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await relayPod.execute(raw(statement));
    }
  });

  // Each test reads exactly which rows a claim took, so none inherits another's.
  beforeEach(() => relayPod.execute(raw('delete from x_outbox')));

  afterAll(async () => {
    await relayPod.close();
    await webPod.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('an idle claim reports a silenced stage in flight until it commits, so the relay never rests on it', async () => {
    using session = await webPod.reserve();
    const inTx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    const pooled = dbExecutor(() => webPod);
    const request = { id: 'request' } as unknown as Tx;
    const autocommit = { id: 'autocommit' } as unknown as Tx;
    const store = postgresOutboxStore({
      executor: dbExecutor(() => relayPod),
      txExecutor: (tx) => (tx === request ? inTx : pooled),
    });
    /** One idle relay pass: claim, publish what it took (marked only), and what it heard. */
    const idleClaim = async (): Promise<{ ids: string[]; dueInMs: number | null | undefined }> => {
      let dueInMs: number | null | undefined;
      const rows = await store.claim(500, { onEmpty: (due) => (dueInMs = due) });
      for (const row of rows) await store.markPublished(row.id, 1, row.claimedBy);
      return { ids: rows.map((row) => row.idempotencyKey), dueInMs };
    };

    // Row one commits on its own and announces itself.
    await store.stage(autocommit, record('one'));
    // Row two, in a request transaction, staged while row one waits unclaimed: silenced.
    await inTx.query('begin', []);
    try {
      await store.stage(request, record('two'));
      // The relay row one woke claims it, then passes again and finds nothing committed.
      expect((await idleClaim()).ids).toEqual(['silent:one']);
      // Nothing to claim, but a silenced stage is in flight: 0, which keeps the relay polling —
      // on every pass, for as long as the request runs.
      for (let pass = 0; pass < 3; pass += 1) {
        expect(await idleClaim()).toEqual({ ids: [], dueInMs: 0 });
      }
      await inTx.query('commit', []);
    } catch (error) {
      await inTx.query('rollback', []);
      throw error;
    }
    // Committed: the next pass finds it. The one behind a claim that took rows still says 0 — its
    // lock read follows its snapshot, so one clear read could be a commit it did not see — and the
    // one behind that, clear twice, may rest.
    expect((await idleClaim()).ids).toEqual(['silent:two']);
    expect(await idleClaim()).toEqual({ ids: [], dueInMs: 0 });
    expect(await idleClaim()).toEqual({ ids: [], dueInMs: null });
  });

  test('a stage in a repeatable-read transaction notifies: its snapshot may predate the claim it would lean on', async () => {
    using session = await webPod.reserve();
    const inTx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    const store = postgresOutboxStore({
      executor: dbExecutor(() => relayPod),
      txExecutor: () => dbExecutor(() => webPod),
    });
    await store.stage({ id: 'autocommit' } as unknown as Tx, record('rr-one'));
    await inTx.query('begin isolation level repeatable read', []);
    try {
      await inTx.query('select 1', []); // the snapshot: row one still unclaimed in it
      // The relay claims and publishes row one, then rests: it runs no SQL until a wake.
      const claimed = await store.claim(500);
      for (const row of claimed) await store.markPublished(row.id, 1, row.claimedBy);
      expect(claimed.map((row) => row.idempotencyKey)).toEqual(['silent:rr-one']);
      // Row two's snapshot still shows row one waiting, but nothing will try the lock: it must
      // announce itself (`woke` is '' when it notified).
      const two = record('rr-two');
      const [staged] = await inTx.query<{ woke: string | null }>(SQL_OUTBOX_STAGE, [
        two.id,
        two.job,
        two.queue,
        JSON.stringify(two.input),
        two.idempotencyKey,
        two.maxAttempts,
        two.runAt,
        two.stagedAt,
        null,
        null,
        null,
        two.runId,
        null,
        null,
      ]);
      expect(staged?.woke).toBe('');
      await inTx.query('commit', []);
    } catch (error) {
      await inTx.query('rollback', []);
      throw error;
    }
  });
});
