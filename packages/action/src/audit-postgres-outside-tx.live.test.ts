// Group commit over the default `dbExecutor()` on Postgres 17: a batch armed by a write inside a
// transaction that then rolls back still stores every other caller's records — and that write's
// own, because an audit row records an attempt. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, probeDatabaseName, sweepProbeDatabases, userActor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, setDbClient, withTransaction } from '@ultimat3/db';
import type { AuditRecord } from './audit';
import { postgresAuditSink, SQL_AUDIT_TABLE } from './audit-postgres';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_action_audit_tx_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

const record = (name: string): AuditRecord => ({
  at: new Date(1_700_000_000_000),
  name,
  primitive: 'action',
  mutator: true,
  surface: 'http',
  ctx: ctxOf({ actor: userActor({ id: 'u1' }) }),
  input: null,
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
});

class RolledBack extends RangeError {}

describe.skipIf(!hasPostgres)(
  'live · postgres · group commit outside the arming transaction',
  () => {
    let admin: PostgresClient;
    let client: PostgresClient;

    const stored = async (): Promise<readonly string[]> =>
      (
        await client.query<{ action: string }>(raw('select action from x_audit order by action'))
      ).map((row) => row.action);

    beforeAll(async () => {
      admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
      await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
      await sweepProbeDatabases(
        dbExecutor(() => admin),
        PROBE_DB,
      );
      await admin.execute(raw(`create database ${PROBE_DB}`));
      client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 4 } });
      for (const statement of SQL_AUDIT_TABLE.split(';')) {
        if (statement.trim().length > 0) await client.execute(raw(statement));
      }
      setDbClient(client);
    });

    beforeEach(async () => {
      await client.execute(raw('truncate x_audit'));
    });

    afterAll(async () => {
      setDbClient(undefined);
      await client.close();
      await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
      await admin.close();
    });

    test('writer A arms the batch in a transaction that rolls back; B’s rows survive', async () => {
      const sink = postgresAuditSink({ executor: dbExecutor(), groupCommit: { maxDelayMs: 50 } });
      try {
        let armed = (): void => undefined;
        const queued = new Promise<void>((resolve) => {
          armed = resolve;
        });
        const writerA = withTransaction(async () => {
          const mine = sink.write(record('a-rolled-back'));
          armed();
          await mine;
          throw new RolledBack('writer A rolls back after its audit row settled');
        }).catch((error: unknown) => error);
        await queued;
        // Writer B, another request: no transaction on its context, same batch as A's.
        await Promise.all([sink.write(record('b-one')), sink.write(record('b-two'))]);
        expect(await writerA).toBeInstanceOf(RolledBack);
      } finally {
        await sink.close();
      }
      expect(await stored()).toEqual(['a-rolled-back', 'b-one', 'b-two']);
    });

    test('a row written inside a transaction that commits is recorded', async () => {
      const sink = postgresAuditSink({ executor: dbExecutor(), groupCommit: true });
      try {
        await withTransaction(() => sink.write(record('committed')));
      } finally {
        await sink.close();
      }
      expect(await stored()).toEqual(['committed']);
    });
  },
);
