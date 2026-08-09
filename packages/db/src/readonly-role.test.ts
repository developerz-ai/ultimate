import { beforeEach, describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import { createRecordingClient, type RecordingClient } from './fake';
import { ensureReadOnlyRole, grantReadOnlySql, READONLY_ROLE } from './readonly-role';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
});

describe('grantReadOnlySql', () => {
  test('returns the seven statements that create, grant and lock down the role', () => {
    expect(grantReadOnlySql()).toHaveLength(7);
  });

  test('guards CREATE ROLE with a pg_roles existence check inside one DO block', () => {
    const [ddl] = grantReadOnlySql();
    expect(ddl?.text).toContain('IF NOT EXISTS');
    expect(ddl?.text).toContain('SELECT 1 FROM pg_roles WHERE rolname');
    expect(ddl?.text).toContain('CREATE ROLE "ultimate_readonly" NOLOGIN NOINHERIT');
    expect(ddl?.text.trim().startsWith('DO $ultimate$')).toBe(true);
    expect(ddl?.text.trim().endsWith('END $ultimate$')).toBe(true);
  });
});

describe('ensureReadOnlyRole', () => {
  test('runs the DDL in order and returns the default role name', async () => {
    const role = await ensureReadOnlyRole(client);

    expect(role).toBe(READONLY_ROLE);
    const all = client.texts.join(' | ');
    expect(all).toContain('CREATE ROLE');
    expect(all).toContain('GRANT SELECT ON ALL TABLES');
    expect(all).toContain('REVOKE ALL ON ALL SEQUENCES');
    expect(all).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES');
    expect(all).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON SEQUENCES');
  });

  test('a custom role/schema is quoted as an identifier everywhere it appears', async () => {
    await ensureReadOnlyRole(client, { role: 'my_role', schema: 'my_schema' });
    const all = client.texts.join(' | ');

    expect(all).toContain('"my_role"');
    expect(all).toContain('"my_schema"');
    // The DO block's existence check compares a string literal, not an identifier — the only
    // place the bare name may legitimately appear without double quotes.
    expect(all).toContain("'my_role'");
    expect(all.replaceAll('"my_role"', '').replaceAll("'my_role'", '')).not.toContain('my_role');
    expect(all.replaceAll('"my_schema"', '')).not.toContain('my_schema');
  });

  test('returns a custom role name on success', async () => {
    expect(await ensureReadOnlyRole(client, { role: 'custom_role' })).toBe('custom_role');
  });

  test('swallows a failure and returns null instead of throwing', async () => {
    const failing: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async () => {
        throw new Error('permission denied to create role');
      },
    };

    const result = await ensureReadOnlyRole(failing);
    expect(result).toBeNull();
  });
});
