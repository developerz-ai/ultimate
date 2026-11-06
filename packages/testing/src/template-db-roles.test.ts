// A row-security app's worker database: the template gets the two roles before it is migrated,
// the migration runs as the migrator, and the worker is handed a URL that serves as the app role.

import { describe, expect, test } from 'bun:test';
import { APP_ROLE, MIGRATOR_ROLE } from '@ultimat3/db';
import type { SqlRunner } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { loginSql } from './template-db-roles';

const ADMIN = 'postgres://ultimate:ultimate@localhost:5432/postgres';

function recorder() {
  const log: { url: string; sql: string }[] = [];
  const connect = (url: string): SqlRunner => ({
    exec: async (sql) => {
      log.push({ url, sql });
    },
    close: async () => undefined,
  });
  return { log, connect };
}

describe('unit · template-db · rowSecurity', () => {
  test('roles in the template, migrate as the migrator, serve as the app role', async () => {
    const { log, connect } = recorder();
    const migrated: string[] = [];
    const db = await acquireWorkerDatabase(
      {
        adminUrl: ADMIN,
        templateName: 'tpl',
        rowSecurity: true,
        migrate: async (url) => {
          migrated.push(url);
        },
      },
      { env: { ULTIMATE_TEST_WORKER: '1' }, connect },
    );
    const inTemplate = log.filter((entry) => new URL(entry.url).pathname === '/tpl');
    expect(inTemplate.map((entry) => entry.sql)).toContain(loginSql(APP_ROLE));
    expect(inTemplate.map((entry) => entry.sql)).toContain(loginSql(MIGRATOR_ROLE));
    expect(migrated.map((url) => new URL(url).username)).toEqual([MIGRATOR_ROLE]);
    expect(new URL(db.url).username).toBe(APP_ROLE);
    expect(new URL(db.url).pathname).toBe('/tpl_w1');
  });

  test('off: no role is touched and the admin credentials serve, as before', async () => {
    const { log, connect } = recorder();
    const db = await acquireWorkerDatabase(
      { adminUrl: ADMIN, templateName: 'tpl', migrate: async () => undefined },
      { env: { ULTIMATE_TEST_WORKER: '1' }, connect },
    );
    expect(log.some((entry) => entry.sql.includes(APP_ROLE))).toBe(false);
    expect(new URL(db.url).username).toBe('ultimate');
  });
});
