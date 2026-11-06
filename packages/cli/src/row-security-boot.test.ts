// The boot check: with `database.rowSecurity` on, a superuser boot is refused and installs nothing;
// a boot as the app role passes and wraps the ambient client. Off, the boot never asks.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineConfig } from '@ultimat3/core';
import { db, recordingClient, setDbClient, transactionSettings } from '@ultimat3/db';
import { armRowSecurity, rowSecurityDeclared } from './row-security-boot';

const roleIs = (superuser: boolean) =>
  recordingClient().on(/from pg_roles/, {
    rows: [{ role: superuser ? 'ultimate' : 'x_app', superuser, bypass: false, unforced: 0 }],
  });

afterEach(() => setDbClient(undefined));

describe('armRowSecurity', () => {
  test('a superuser boot is refused, and nothing is installed', async () => {
    const pool = roleIs(true);
    setDbClient(pool);
    await expect(armRowSecurity(true)).rejects.toMatchObject({
      code: 'X_DB_ROW_SECURITY_BYPASSED',
    });
    expect(db()).toBe(pool);
    expect(transactionSettings()).toBeUndefined();
  });

  test('a boot as the app role passes, wraps the client, and its undo puts it back', async () => {
    const pool = roleIs(false);
    setDbClient(pool);
    const undo = await armRowSecurity(true);
    expect(db()).not.toBe(pool);
    await undo();
    expect(db()).toBe(pool);
    expect(transactionSettings()).toBeUndefined();
  });

  test('off: no statement, nothing installed', async () => {
    const pool = roleIs(true);
    setDbClient(pool);
    await armRowSecurity(false);
    expect(pool.texts).toEqual([]);
    expect(db()).toBe(pool);
  });
});

describe('rowSecurityDeclared', () => {
  test('the typed field decides; no app.config.ts is off', () => {
    const on = defineConfig({ name: 'rls-app', database: { rowSecurity: true } });
    expect(rowSecurityDeclared(on)).toBe(true);
    expect(rowSecurityDeclared(defineConfig({ name: 'rls-app' }))).toBe(false);
    expect(rowSecurityDeclared(undefined)).toBe(false);
  });
});
