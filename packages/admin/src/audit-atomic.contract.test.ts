// An action and its entry commit TOGETHER against a real Postgres (embedded PGlite): the handler's
// write and the `allowed` entry are one transaction, so an entry that cannot be written takes the
// write back out and the log holds exactly one `failed` entry — never "failed" for a committed act.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { db, pgliteClient, raw, setDbClient } from '@ultimat3/db';
import { invokeAdminAction } from './action-gate';
import { postgresAuditLog } from './audit-pg';
import { ADMIN_AUDIT_TABLE, SQL_ADMIN_AUDIT_TABLE } from './audit-schema';
import { staticAuthz } from './authz';
import type { AdminAction } from './registry';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  for (const statement of SQL_ADMIN_AUDIT_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
  await client.execute(raw('create table admin_atomic_probe (id text primary key)'));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

/** The handler an app writes: its statement goes through the process's `db()`, as any would. */
const stamp: AdminAction = {
  name: 'probe.stamp',
  permission: 'probe:write',
  entity: 'probe',
  handle: async ({ input }) => {
    await db().execute(
      raw(`insert into admin_atomic_probe (id) values ('${String(input['id'])}')`),
    );
  },
};

const probeRows = async (): Promise<readonly string[]> =>
  (await client.query<{ id: string }>(raw('select id from admin_atomic_probe order by id'))).map(
    (row) => row.id,
  );

const outcomesFor = async (requestId: string): Promise<readonly string[]> =>
  (
    await client.query<{ outcome: string }>(
      raw(`select outcome from ${ADMIN_AUDIT_TABLE} where request_id = '${requestId}'`),
    )
  ).map((row) => row.outcome);

const invoke = (id: string, failingSink: boolean) =>
  invokeAdminAction({
    action: stamp,
    input: { id },
    actor: { id: 'u-op', roles: ['ops'] },
    authz: staticAuthz(['admin:write', 'probe:write']),
    audit: postgresAuditLog({
      sinks: failingSink
        ? [
            {
              write: (entry) => {
                // A foreign failure handed to the code under test is input, not a verdict.
                if (entry.outcome === 'allowed') {
                  throw new UltimateError({
                    code: 'X_ADMIN_INVALID',
                    cause: 'sink',
                    fix: 'x doctor',
                  });
                }
              },
            },
          ]
        : [],
    }),
    requestId: `req-${id}`,
  });

describe('contract · an action commits with its entry on Postgres', () => {
  test(
    'the handler’s write and the allowed entry land together',
    async () => {
      await invoke('kept', false);
      expect(await probeRows()).toContain('kept');
      expect(await outcomesFor('req-kept')).toEqual(['allowed']);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'an entry that cannot be written rolls the write back, and the log says failed — once',
    async () => {
      await expect(invoke('lost', true)).rejects.toBeUltimateError('X_ADMIN_INVALID');
      expect(await probeRows()).not.toContain('lost');
      expect(await outcomesFor('req-lost')).toEqual(['failed']);
    },
    PGLITE_BOOT_MS,
  );
});
