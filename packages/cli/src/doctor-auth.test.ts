// `x doctor`'s auth-storage rule, and the probe that feeds it against a real server: an operator
// is told at deploy — not by a user at sign-in — that secrets are still unsealed or a retired
// table is still there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AUTH_TABLES } from '@ultimat3/auth';
import {
  authStorageFindings,
  authStorageProbe,
  NO_AUTH_STORAGE_FACT,
  RETIRED_FRAMEWORK_TABLES,
} from './doctor-auth';

describe('unit · doctor · auth storage', () => {
  test('nothing left over is no finding', () => {
    expect(authStorageFindings(NO_AUTH_STORAGE_FACT)).toEqual([]);
  });

  test('unsealed secrets are named by count, with the one-shot as the fix', () => {
    const [finding, ...rest] = authStorageFindings({ unsealedMfaSecrets: 3, retiredTables: [] });
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MFA_SECRET_UNSEALED');
    expect(finding?.cause).toContain('3 user(s)');
    expect(finding?.fix).toBe('x auth seal-mfa --json');
  });

  test('a retired table is its own finding, and the fix drops exactly that table', () => {
    const findings = authStorageFindings({
      unsealedMfaSecrets: 1,
      retiredTables: ['x_auth_failures'],
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_MFA_SECRET_UNSEALED',
      'X_FRAMEWORK_TABLE_ORPHANED',
    ]);
    expect(findings[1]?.fix).toContain("-c 'drop table if exists x_auth_failures'");
  });

  test('an embedded or unset database is not opened', async () => {
    expect(await authStorageProbe(undefined)).toBe(NO_AUTH_STORAGE_FACT);
    expect(await authStorageProbe('  ')).toBe(NO_AUTH_STORAGE_FACT);
  });

  test('the retired list names the table the limiter stopped creating', () => {
    expect(RETIRED_FRAMEWORK_TABLES).toEqual(['x_auth_failures']);
  });
});

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
/** Its own database: the probe reads the whole of `x_users`, and this file creates a table. */
const PROBE_DB = 'x_doctor_auth_probe';

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async (target: string, statement: string): Promise<void> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

describeLive('live · postgres · doctor · auth storage', () => {
  beforeAll(async () => {
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
    await on(url ?? '', `create database ${PROBE_DB}`);
  });

  afterAll(async () => {
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  });

  test('a database with no auth tables at all reports nothing', async () => {
    expect(await authStorageProbe(probeUrl())).toEqual({
      unsealedMfaSecrets: 0,
      retiredTables: [],
    });
  });

  test('it counts the plaintext secrets, not the sealed ones, and sees the retired table', async () => {
    for (const statement of AUTH_TABLES.join(';').split(';')) {
      if (statement.trim() !== '') await on(probeUrl(), statement);
    }
    await on(probeUrl(), 'create table x_auth_failures (key text not null, at_ms bigint not null)');
    const row = (id: number, secret: string): string =>
      `insert into x_users (id, email, mfa_secret) values ('00000000-0000-7000-8000-00000000050${id}', 'u${id}@corp.test', ${secret})`;
    await on(probeUrl(), row(1, "'JBSWY3DPEHPK3PXP'"));
    await on(probeUrl(), row(2, "'GEZDGNBVGY3TQOJQ'"));
    await on(probeUrl(), row(3, 'null'));

    expect(await authStorageProbe(probeUrl())).toEqual({
      unsealedMfaSecrets: 2,
      retiredTables: ['x_auth_failures'],
    });
  });

  test('a server that does not answer is not this probe’s finding to make', async () => {
    const dead = new URL(probeUrl());
    dead.pathname = '/x_no_such_database';
    expect(await authStorageProbe(dead.href)).toBe(NO_AUTH_STORAGE_FACT);
  });
});
