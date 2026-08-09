// Single responsibility: isolated tests for layer 1's DDL and privilege boundaries — the role is
// created once, every name is quoted, and default privileges reach the tables migrations create
// later. This is the layer Postgres itself enforces, so a hole here is one no other layer sees,
// and it is invisible until the day a new table turns out to be readable or unreadable.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import { dbUnavailable } from './errors';
import { createRecordingClient, type RecordingClient } from './fake';
import { ensureReadOnlyRole, grantReadOnlySql, READONLY_ROLE } from './readonly-role';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
});

/** Statement texts with runs of whitespace collapsed — what the assertions match on. */
const squashed = (statements: ReturnType<typeof grantReadOnlySql>): string =>
  statements.map((statement) => statement.text.replace(/\s+/g, ' ').trim()).join(' | ');

describe('grantReadOnlySql', () => {
  test('returns the seven statements that create, grant and lock down the role', () => {
    // Five fixed statements plus one ALTER DEFAULT PRIVILEGES pair for the default creator.
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

  test('the default creator is the bare CURRENT_USER keyword, never a quoted identifier', () => {
    const all = squashed(grantReadOnlySql());
    expect(all).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "public"');
    expect(all).not.toContain('"CURRENT_USER"');
  });

  test('every named creator gets its own default-privileges pair', () => {
    const statements = grantReadOnlySql({ creators: ['app_migrator', 'app_owner'] });
    const all = squashed(statements);

    expect(statements).toHaveLength(9);
    expect(all).toContain('FOR ROLE "app_migrator" IN SCHEMA "public" GRANT SELECT ON TABLES');
    expect(all).toContain('FOR ROLE "app_migrator" IN SCHEMA "public" REVOKE ALL ON SEQUENCES');
    expect(all).toContain('FOR ROLE "app_owner" IN SCHEMA "public" GRANT SELECT ON TABLES');
    expect(all).toContain('FOR ROLE "app_owner" IN SCHEMA "public" REVOKE ALL ON SEQUENCES');
    // Naming creators replaces the default rather than adding to it.
    expect(all).not.toContain('CURRENT_USER IN SCHEMA');
  });

  test('an empty creators list falls back to CURRENT_USER instead of emitting no pair', () => {
    expect(squashed(grantReadOnlySql({ creators: [] }))).toContain('FOR ROLE CURRENT_USER');
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
    expect(all).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "public" GRANT SELECT ON TABLES',
    );
    expect(all).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "public" REVOKE ALL ON SEQUENCES',
    );
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
        // What a managed Postgres actually produces here: the app user is not a role admin, and
        // `client.ts` maps every refused statement to X_DB_UNAVAILABLE before this layer sees it.
        throw dbUnavailable('statement failed: CREATE ROLE — permission denied to create role');
      },
    };

    const result = await ensureReadOnlyRole(failing);
    expect(result).toBeNull();
  });
});
