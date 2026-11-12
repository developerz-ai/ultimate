// An entity that declares `version:` through the admin: the version is never an operator's input,
// a partial update (a form, an MCP call) carries the version the admin READ, and a write that lost
// the race after that read is the `stale` conflict a re-render shows — not a thrown error.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { staticAuthz } from './authz';
import { adminUpdate, type CrudCtx } from './crud';
import type { AdminRepo, AdminRow } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';
import { ROW_CHANGED_REASON, rowVersion } from './row-version';

const notes = entity('admin_lock_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    lockVersion: integer().default(0),
  },
  version: 'lockVersion',
});
const db = database({ notes }, { driver: memoryDriver() });

afterAll(clearRegistry);

const bound = (over: Partial<AdminRepo<AdminRow>> = {}) =>
  adminResource(notes, { repo: { ...adminRepoFor(notes, db.notes), ...over } });

const ctxOf = (): CrudCtx => ({
  actor: { id: 'u_1', roles: ['admin'] },
  authz: staticAuthz(['admin:write', 'admin_lock_notes:write']),
  audit: memoryAuditLog(),
  requestId: 'req_lock',
});

describe('admin · an entity with a version lock', () => {
  test('the version is no form field, so neither the form nor the MCP tool offers it', () => {
    expect(bound().formFields.map((field) => field.name)).toEqual(['title']);
  });

  test('a partial update with no version writes at the version it read, and advances it', async () => {
    const row = await db.notes.insert({ title: 'Draft' });
    const result = await adminUpdate(bound(), ctxOf(), row.id, { title: 'Final' });
    expect(result.ok).toBe(true);
    expect(await db.notes.where({ id: row.id }).one()).toMatchObject({
      title: 'Final',
      lockVersion: 1,
    });
  });

  test('a form edit round-tripping its version writes', async () => {
    const row = await db.notes.insert({ title: 'Draft' });
    const shown = await db.notes.where({ id: row.id }).one();
    if (shown === null) return expect.unreachable('the row was just inserted');
    const result = await adminUpdate(
      bound(),
      ctxOf(),
      row.id,
      { title: 'Final' },
      {
        version: rowVersion(shown),
      },
    );
    expect(result.ok).toBe(true);
  });

  test('a write that lost the race after the read is `stale`, audited once, theirs kept', async () => {
    const row = await db.notes.insert({ title: 'Shared' });
    const base = adminRepoFor(notes, db.notes);
    // Another writer lands between the admin's read and its write.
    const racing = bound({
      update: async (id, patch) => {
        await db.notes.update(id, { title: 'Theirs', lockVersion: 0 });
        return base.update(id, patch);
      },
    });
    const ctx = ctxOf();
    const result = await adminUpdate(racing, ctx, row.id, { title: 'Mine' });
    if (result.ok || result.kind !== 'stale') return expect.unreachable('expected a stale result');
    expect(result.row).toMatchObject({ title: 'Theirs', lockVersion: 1 });
    expect(result.version).toBe(rowVersion(result.row));
    expect(await db.notes.where({ id: row.id }).one()).toMatchObject({ title: 'Theirs' });
    const entries = await ctx.audit.entries();
    expect(entries.map((entry) => [entry.outcome, entry.reason])).toEqual([
      ['failed', ROW_CHANGED_REASON],
    ]);
  });
});
