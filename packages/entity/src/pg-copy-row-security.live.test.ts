// `copyAll` with row security armed, connected as a role the policy applies to. Postgres refuses
// `COPY FROM` on a table under row-level security (`0A000`) whether or not a tenant is in scope,
// so `copyAll` must take the `insert` path there — and then answer exactly as `insertAll` does:
// rows stored under a tenant, the same refusal with none.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError, subscribe } from '@ultimat3/core';
import {
  enableRowSecuritySql,
  type PostgresClient,
  postgresClient,
  raw,
  rowSecureClient,
  setDbClient,
  setTransactionSettings,
} from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const TABLE = 'pg_copy_rls_loads';
const ROLE = 'x_copy_rls_app';
const A = '00000000-0000-4000-8000-00000000000a';

const loads = entity(TABLE, {
  columns: { id: integer().primaryKey(), orgId: uuid(), label: text() },
});

const asRole = (base: string): string => {
  const next = new URL(base);
  next.username = ROLE;
  next.password = ROLE;
  return next.toString();
};

let settings: Readonly<Record<string, string>> | undefined;

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · copyAll under row security', () => {
  let admin: PostgresClient;
  let app: PostgresClient;
  const db = () => database({ loads }, { driver: postgresDriver() });

  /** What `work` answered — a count or a code — and the verbs it sent against the table. */
  const outcome = async (work: () => Promise<number>): Promise<[number | string, string[]]> => {
    const verbs: string[] = [];
    const off = subscribe('db.statement', ({ payload }) => {
      if (payload.text.includes(TABLE)) verbs.push(payload.text.split(' ')[0] ?? '');
    });
    try {
      const answer = await work().catch((error: unknown) =>
        isUltimateError(error) ? error.code : 'uncoded',
      );
      return [answer, verbs];
    } finally {
      off();
    }
  };

  beforeAll(async () => {
    admin = postgresClient({ url: adminUrl ?? '', role: 'migrate', profile: { max: 1 } });
    await admin.execute(raw(`drop table if exists "${TABLE}"`));
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.execute(
      raw(`create role ${ROLE} login password '${ROLE}' nosuperuser nobypassrls`),
    );
    await admin.execute(
      raw(
        `create table "${TABLE}" (id integer primary key, org_id uuid not null, label text not null)`,
      ),
    );
    for (const statement of enableRowSecuritySql(TABLE, 'org_id', 'uuid')) {
      await admin.execute(raw(statement));
    }
    await admin.execute(raw(`grant select, insert, update, delete on "${TABLE}" to ${ROLE}`));
    app = postgresClient({ url: asRole(adminUrl ?? ''), role: 'web', profile: { max: 2 } });
    setDbClient(rowSecureClient(app));
    setTransactionSettings(() => settings);
  });

  afterAll(async () => {
    setTransactionSettings(undefined);
    setDbClient(undefined);
    await app.close();
    await admin.execute(raw(`drop table if exists "${TABLE}"`));
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.close();
  });

  test('the premise: Postgres refuses COPY FROM on this table with no tenant in scope', async () => {
    const copied = await app
      .copyIn(raw(`copy "${TABLE}" ("id", "org_id", "label") from stdin`), [[90, A, 'x']])
      .catch((error: unknown) => error);
    expect(isUltimateError(copied)).toBe(true);
    expect(String((copied as Error).message)).toContain('row-level security');
  });

  test('a tenant in scope: copyAll inserts, stores what insertAll stores', async () => {
    settings = { 'x.tenant': A };
    const [copied, verbs] = await outcome(() =>
      db().loads.copyAll([
        { id: 1, orgId: A, label: 'a' },
        { id: 2, orgId: A, label: 'b' },
      ]),
    );
    const [inserted] = await outcome(() =>
      db().loads.insertAll([{ id: 3, orgId: A, label: 'c' }], { returning: false }),
    );
    expect(copied).toBe(2);
    expect(inserted).toBe(1);
    expect(verbs).toEqual(['insert']);
  });

  test('no tenant in scope: copyAll refuses exactly as insertAll does, and sends no COPY', async () => {
    settings = undefined;
    const [copied, verbs] = await outcome(() =>
      db().loads.copyAll([{ id: 10, orgId: A, label: 'x' }]),
    );
    const [inserted] = await outcome(() =>
      db().loads.insertAll([{ id: 11, orgId: A, label: 'y' }], { returning: false }),
    );
    expect(typeof copied).toBe('string');
    expect(copied).toBe(inserted);
    expect(verbs).toEqual(['insert']);
  });
});
