// The `/_x` SQL runner's statements, as a recording client sees them: the panel's read assumes the
// SELECT-only role inside its read-only transaction, the role's DDL runs once per runner, and a
// database that refuses the role still answers — layer 1 absent, the other layers held.

import { describe, expect, test } from 'bun:test';
import { type DbClient, READONLY_ROLE } from '@ultimat3/db';
import { readOnlySql } from './sql-runner';

/** Every statement text, in order; `refuseRoles` answers the role's DDL as a managed Postgres. */
function recording(refuseRoles: boolean | number = false): { client: DbClient; seen: string[] } {
  // A number: refuse the role's DDL that many times, then grant it — a race lost, then won.
  let refusals =
    refuseRoles === true ? Number.POSITIVE_INFINITY : refuseRoles === false ? 0 : refuseRoles;
  const seen: string[] = [];
  // The driver's refusal is this fixture's INPUT, a foreign error — bound once, thrown by name.
  const duplicate = new TypeError(
    'duplicate key value violates unique constraint "pg_authid_rolname_index"',
  );
  const client: DbClient = {
    query: async (fragment) => {
      seen.push(fragment.text);
      return [{ n: 1 }] as never[];
    },
    one: async () => null,
    execute: async (fragment) => {
      seen.push(fragment.text);
      if (refusals > 0 && /CREATE ROLE/.test(fragment.text)) {
        refusals -= 1;
        throw duplicate;
      }
      return 0;
    },
  };
  return { client, seen };
}

describe('unit · readOnlySql', () => {
  test('the read runs as the SELECT-only role, inside the read-only transaction', async () => {
    const { client, seen } = recording();
    await readOnlySql(client)('select 1 as n');
    const begin = seen.indexOf('BEGIN READ ONLY');
    const role = seen.findIndex((text) => text.startsWith('SET LOCAL ROLE'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(role).toBeGreaterThan(begin);
    expect(seen[role]).toBe(`SET LOCAL ROLE "${READONLY_ROLE}"`);
    expect(role).toBeLessThan(seen.findIndex((text) => text.includes('select 1 as n')));
  });

  test("the role's DDL runs once per runner, not once per statement", async () => {
    const { client, seen } = recording();
    const run = readOnlySql(client);
    await run('select 1 as n');
    await run('select 2 as n');
    expect(seen.filter((text) => text.includes('CREATE ROLE'))).toHaveLength(1);
    expect(seen.filter((text) => text.startsWith('SET LOCAL ROLE'))).toHaveLength(2);
  });

  test('a database that refuses the role still answers, read-only, without assuming it', async () => {
    const { client, seen } = recording(true);
    const result = await readOnlySql(client)('select 1 as n');
    expect(result.rows).toEqual([[1]]);
    expect(seen).toContain('BEGIN READ ONLY');
    expect(seen.some((text) => text.startsWith('SET LOCAL ROLE'))).toBe(false);
  });

  test('a role that failed once is asked for again, not cached as absent for the session', async () => {
    const { client, seen } = recording(1);
    const run = readOnlySql(client);
    await run('select 1 as n');
    expect(seen.some((text) => text.startsWith('SET LOCAL ROLE'))).toBe(false);
    seen.length = 0;
    await run('select 1 as n');
    expect(seen).toContain(`SET LOCAL ROLE "${READONLY_ROLE}"`);
    seen.length = 0;
    // Granted is an answer: kept, so the DDL does not run per statement.
    await run('select 1 as n');
    expect(seen.some((text) => text.includes('CREATE ROLE'))).toBe(false);
  });
});
