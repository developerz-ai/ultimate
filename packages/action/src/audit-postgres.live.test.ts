// The durable sink against Postgres 17: a table created before `primitive` existed gains it by the
// boot's own DDL, an old row reads as what it always was — an action's — and a record's `name`
// lands in the `action` column, which 25.0.0 kept. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import type { AuditRecord } from './audit';
import { postgresAuditSink, SQL_AUDIT_TABLE } from './audit-postgres';
import { executorFor } from './idempotency-tx-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = 'x_action_audit_live';

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** The table as 24.x before this column shipped: the `create` alone, no `alter`. */
const PRE_PRIMITIVE_TABLE = SQL_AUDIT_TABLE.split(';')[0] ?? '';

const applyDdl = async (client: PostgresClient): Promise<void> => {
  for (const statement of SQL_AUDIT_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
};

const recordNamed = (name: string): AuditRecord => ({
  at: new Date(1_700_000_000_000),
  name,
  primitive: 'action',
  mutator: false,
  surface: 'http',
  ctx: createContext({ actor: userActor({ id: 'u1', orgId: 'org-1' }) }),
  input: { postId: 'p1' },
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
});

describe.skipIf(!hasPostgres)(
  'live · postgres · x_audit keeps a pre-`primitive` table whole',
  () => {
    let admin: PostgresClient;
    let client: PostgresClient;

    beforeAll(async () => {
      admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
      await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
      await admin.execute(raw(`create database ${PROBE_DB}`));
      client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
      await client.execute(raw(PRE_PRIMITIVE_TABLE));
      await client.execute(
        raw(`insert into x_audit (id, action, mutator, surface, outcome, replayed, actor_id,
        actor_kind, request_id, trace_id, locale, tz, build_id, role)
        values (gen_random_uuid(), 'beforeTheColumn', false, 'http', 'allowed', false, 'u0',
        'user', 'r0', 't0', 'en', 'UTC', 'b0', 'web')`),
      );
      await applyDdl(client);
    });

    afterAll(async () => {
      await client.close();
      await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
      await admin.close();
    });

    test('a row written before the column existed reads as an action', async () => {
      const rows = await client.query<{ primitive: string }>(
        raw(`select primitive from x_audit where action = 'beforeTheColumn'`),
      );
      expect(rows).toEqual([{ primitive: 'action' }]);
    });

    test('a record round-trips: its name in the `action` column, primitive action', async () => {
      await postgresAuditSink({ executor: executorFor(client) }).write(recordNamed('oldShape'));

      const rows = await client.query<{ action: string; primitive: string; actor_id: string }>(
        raw(`select action, primitive, actor_id from x_audit where action = 'oldShape'`),
      );
      expect(rows).toEqual([{ action: 'oldShape', primitive: 'action', actor_id: 'u1' }]);
    });

    test('a read is recorded as a read', async () => {
      await postgresAuditSink({ executor: executorFor(client) }).write({
        ...recordNamed('postList'),
        primitive: 'query',
      });

      const rows = await client.query<{ primitive: string }>(
        raw(`select primitive from x_audit where action = 'postList'`),
      );
      expect(rows).toEqual([{ primitive: 'query' }]);
    });

    test('the DDL is idempotent: applying it again over the migrated table changes nothing', async () => {
      await applyDdl(client);
      const rows = await client.query<{ n: number }>(raw('select count(*)::int as n from x_audit'));
      expect(rows).toEqual([{ n: 3 }]);
    });
  },
);
