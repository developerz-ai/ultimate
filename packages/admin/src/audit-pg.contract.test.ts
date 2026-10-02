// The durable audit log against a REAL Postgres (embedded PGlite, on a directory): entries survive
// a restart, a row's trail pages by keyset with no entry seen twice, and a write that rolls back
// takes its entry with it. A recording executor could prove none of the three.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; a restart needs a data directory to reopen.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { createPgliteClient, type PgliteClient, raw } from '@ultimat3/db';
import { type AuditDraft, auditCursorOf, memoryAuditLog, REDACTED } from './audit';
import { postgresAuditLog } from './audit-pg';
import { ADMIN_AUDIT_TABLE, SQL_ADMIN_AUDIT_TABLE } from './audit-schema';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

const dataDir = mkdtempSync(join(tmpdir(), 'ultimate-admin-audit-'));
let client: PgliteClient = createPgliteClient({ dataDir });

const statements = SQL_ADMIN_AUDIT_TABLE.split(';').filter((one) => one.trim().length > 0);

/** A clock that moves one second per entry, so the trail has an order a test can name. */
const clockFrom = (startMs: number): (() => Date) => {
  let at = startMs;
  return () => {
    at += 1_000;
    return new Date(at);
  };
};

const draft = (over: Partial<AuditDraft> = {}): AuditDraft => ({
  requestId: 'req-1',
  actor: { id: 'u_1', roles: ['admin'], orgId: 'org-1' },
  operation: 'update',
  kind: 'operation',
  entity: 'posts',
  entityId: 'p1',
  permission: 'posts:write',
  outcome: 'allowed',
  reason: 'admin.policy.all-granted',
  diff: [{ field: 'title', before: 'a', after: 'b' }],
  ...over,
});

beforeAll(async () => {
  for (const statement of statements) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('contract · the Postgres audit log', () => {
  test(
    'entries survive a restart, and a row’s trail pages by keyset',
    async () => {
      const first = postgresAuditLog({ client, now: clockFrom(1_700_000_000_000) });
      for (const title of ['one', 'two', 'three', 'four', 'five']) {
        await first.append(draft({ diff: [{ field: 'title', before: null, after: title }] }));
      }
      // Another row's entry, and an allowed READ of this one: neither is in p1's history.
      await first.append(draft({ entityId: 'p2' }));
      await first.append(draft({ operation: 'detail', diff: [] }));

      // The restart: the process that wrote is gone, and a new one opens the same database.
      await client.close();
      client = createPgliteClient({ dataDir });
      const second = postgresAuditLog({ client });

      const trail = { entity: 'posts', entityId: 'p1', changes: true, limit: 2 } as const;
      const pageOne = await second.entries(trail);
      expect(pageOne.map((entry) => entry.diff[0]?.after)).toEqual(['five', 'four']);
      const cursorOne = auditCursorOf(pageOne);
      if (cursorOne === null) return expect.unreachable('page one is empty');
      const pageTwo = await second.entries({ ...trail, before: cursorOne });
      expect(pageTwo.map((entry) => entry.diff[0]?.after)).toEqual(['three', 'two']);
      const cursorTwo = auditCursorOf(pageTwo);
      if (cursorTwo === null) return expect.unreachable('page two is empty');
      const pageThree = await second.entries({ ...trail, before: cursorTwo });
      expect(pageThree.map((entry) => entry.diff[0]?.after)).toEqual(['one']);
      expect(
        await second.entries({ ...trail, before: auditCursorOf(pageThree) ?? cursorTwo }),
      ).toEqual([]);

      // The whole entry comes back as it was written: actor, tenant, instant, reason.
      expect(pageThree[0]).toMatchObject({
        at: '2023-11-14T22:13:21.000Z',
        requestId: 'req-1',
        actor: { id: 'u_1', roles: ['admin'], orgId: 'org-1' },
        operation: 'update',
        kind: 'operation',
        entity: 'posts',
        entityId: 'p1',
        permission: 'posts:write',
        outcome: 'allowed',
      });
    },
    PGLITE_BOOT_MS,
  );

  test(
    'an allowed read is not written unless the log is told to keep reads; a refused one always is',
    async () => {
      const count = async (): Promise<number> =>
        (
          await client.query<{ n: number }>(
            raw(`select count(*)::int as n from ${ADMIN_AUDIT_TABLE}`),
          )
        )[0]?.n ?? 0;
      const quiet = postgresAuditLog({ client });
      const before = await count();
      const read = await quiet.append(draft({ operation: 'list', entityId: null, diff: [] }));
      // The entry is still ANSWERED — the caller renders it — and it is simply not a row.
      expect(read.operation).toBe('list');
      expect(await count()).toBe(before);
      await quiet.append(draft({ operation: 'list', entityId: null, outcome: 'denied', diff: [] }));
      expect(await count()).toBe(before + 1);

      const keeping = postgresAuditLog({ client, reads: true });
      await keeping.append(draft({ operation: 'list', entityId: null, diff: [] }));
      expect(await count()).toBe(before + 2);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'filters name the tenant and the actor, and a money diff is written without throwing',
    async () => {
      const log = postgresAuditLog({ client });
      const written = await log.append(
        draft({
          actor: { id: 'u_9', roles: [], orgId: 'org-9' },
          entityId: 'p9',
          diff: [
            {
              field: 'price',
              before: { minor: 100n, currency: 'EUR' },
              after: { minor: 250n, currency: 'EUR' },
            },
            { field: 'token', before: REDACTED, after: REDACTED },
          ],
        }),
      );
      const [found] = await log.entries({ orgId: 'org-9', actorId: 'u_9' });
      expect(found?.id).toBe(written.id);
      // A bigint has no JSON: it is stored, and read back, as its digits.
      expect(found?.diff).toEqual([
        {
          field: 'price',
          before: { minor: 100, currency: 'EUR' },
          after: { minor: 250, currency: 'EUR' },
        },
        { field: 'token', before: REDACTED, after: REDACTED },
      ]);
      expect(await log.entries({ orgId: 'org-nobody' })).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'atomic: an entry written beside a write that fails is rolled back with it',
    async () => {
      const log = postgresAuditLog({ client });
      // A foreign error handed to the code under test is input, not a verdict.
      const boom = new UltimateError({
        code: 'X_ADMIN_INVALID',
        cause: 'the write this entry describes did not happen',
        fix: 'x manifest',
      });
      await expect(
        log.atomic(async () => {
          await log.append(draft({ entityId: 'rolled-back' }));
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await log.entries({ entity: 'posts', entityId: 'rolled-back' })).toEqual([]);

      await log.atomic(() => log.append(draft({ entityId: 'committed' })));
      expect(await log.entries({ entity: 'posts', entityId: 'committed' })).toHaveLength(1);
    },
    PGLITE_BOOT_MS,
  );

  test('the memory log answers the same query in the same order', async () => {
    const log = memoryAuditLog({ now: clockFrom(1_700_000_000_000) });
    for (const title of ['one', 'two', 'three']) {
      await log.append(draft({ diff: [{ field: 'title', before: null, after: title }] }));
    }
    await log.append(draft({ operation: 'detail', diff: [] }));
    const trail = { entity: 'posts', entityId: 'p1', changes: true, limit: 2 } as const;
    const pageOne = await log.entries(trail);
    expect(pageOne.map((entry) => entry.diff[0]?.after)).toEqual(['three', 'two']);
    const cursor = auditCursorOf(pageOne);
    if (cursor === null) return expect.unreachable('page one is empty');
    const pageTwo = await log.entries({ ...trail, before: cursor });
    expect(pageTwo.map((entry) => entry.diff[0]?.after)).toEqual(['one']);
  });
});
