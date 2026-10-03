// An action and its audit entry commit together: the handler, a set-based "all matching" and a
// queued batch's enqueues each run INSIDE `audit.atomic` with their `allowed` entry, and an entry
// that cannot be written rolls the work back and leaves one `failed` entry, written outside.
// A journalling log stands in for the transaction; `audit-atomic.contract` runs a real one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { knownPermissions, permissionDeclarationSites, restorePermissions } from '@ultimat3/policy';
import type { AdminApp } from './admin';
import { type AuditDraft, type AuditEntry, type AuditLog, auditEntry } from './audit';
import { staticAuthz } from './authz';
import type { BatchEnqueue } from './batch';
import type { AdminAction } from './registry';

const { defineAdmin } = await import('./admin');
const { runAdminBatch } = await import('./batch');
const { batchIdOf } = await import('./batch-queue');
const { callAdminTool } = await import('./mcp');

/** A log that keeps what a transaction would: entries appended inside `atomic` land on commit. */
interface Journal extends AuditLog {
  readonly events: string[];
  readonly committed: AuditEntry[];
  /** Make the next `allowed` append throw — the sink or the insert failing after the work ran. */
  failNextAllowed(): void;
  readonly inside: () => boolean;
}

const journal = (): Journal => {
  const events: string[] = [];
  const committed: AuditEntry[] = [];
  let pending: AuditEntry[] | null = null;
  let failing = false;
  let next = 0;
  return {
    kind: 'journal',
    events,
    committed,
    failNextAllowed: () => {
      failing = true;
    },
    inside: () => pending !== null,
    async append(draft: AuditDraft): Promise<AuditEntry> {
      if (failing && draft.outcome === 'allowed') {
        failing = false;
        // A foreign failure handed to the code under test is input, not a verdict.
        throw new UltimateError({ code: 'X_ADMIN_INVALID', cause: 'sink down', fix: 'x doctor' });
      }
      next += 1;
      const entry = auditEntry(draft, `e${next}`, new Date('2026-10-02T00:00:00.000Z'));
      events.push(`append:${draft.outcome}:${pending === null ? 'out' : 'in'}`);
      (pending ?? committed).push(entry);
      return entry;
    },
    async entries() {
      return [...committed].reverse();
    },
    async atomic<T>(run: () => Promise<T>): Promise<T> {
      if (pending !== null) return run();
      pending = [];
      events.push('begin');
      try {
        const value = await run();
        committed.push(...pending);
        events.push('commit');
        return value;
      } catch (error) {
        events.push('rollback');
        throw error;
      } finally {
        pending = null;
      }
    },
  };
};

const crates = entity('admin_atomic_crates', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});

const log = journal();
const work: string[] = [];
const seal: AdminAction = {
  name: 'crate.seal',
  permission: 'admin_atomic_crates:write',
  entity: 'admin_atomic_crates',
  batch: { threshold: 1, chunk: 1 },
  handle: async () => {
    work.push(`handle:${log.inside() ? 'in' : 'out'}`);
  },
  matching: async () => {
    work.push(`matching:${log.inside() ? 'in' : 'out'}`);
    return { affected: 2, remaining: 0 };
  },
};

const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();
let admin: AdminApp;
let ids: string[] = [];

beforeAll(async () => {
  const db = database({ crates }, { driver: memoryDriver() });
  admin = defineAdmin({
    basePath: '/atomic',
    entities: [crates],
    db,
    actions: [seal],
    audit: log,
    auth: {
      authz: staticAuthz(['admin:write', 'admin_atomic_crates:read', 'admin_atomic_crates:write']),
    },
  });
  ids = [
    String((await db.crates.insert({ title: 'a' })).id),
    String((await db.crates.insert({ title: 'b' })).id),
    String((await db.crates.insert({ title: 'c' })).id),
  ];
});

afterAll(() => {
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const reset = (): void => {
  log.events.length = 0;
  log.committed.length = 0;
  work.length = 0;
};
const ctx = () => admin.ctx({ actor: { id: 'u-op', roles: ['ops'] }, requestId: 'r-1' });
const outcomes = (): string[] => log.committed.map((entry) => entry.outcome);

describe('unit · an action commits with its entry', () => {
  test('the handler and its allowed entry run inside one atomic unit', async () => {
    reset();
    await callAdminTool(admin, ctx(), 'admin.action.crate.seal', { id: ids[0] });
    expect(work).toEqual(['handle:in']);
    expect(log.events).toEqual(['begin', 'append:allowed:in', 'commit']);
  });

  test('an entry that cannot be written rolls the handler back and logs ONE failed entry', async () => {
    reset();
    log.failNextAllowed();
    await expect(
      callAdminTool(admin, ctx(), 'admin.action.crate.seal', { id: ids[0] }),
    ).rejects.toBeUltimateError('X_ADMIN_INVALID');
    expect(log.events).toEqual(['begin', 'rollback', 'append:failed:out']);
    expect(outcomes()).toEqual(['failed']);
  });
});

describe('unit · "all matching" commits with its one entry', () => {
  const all = { kind: 'all', request: {} } as const;

  test('the set-based call and its entry are one unit', async () => {
    reset();
    const result = await runAdminBatch({
      resource: admin.resource('admin_atomic_crates'),
      action: seal,
      ctx: ctx(),
      selection: all,
    });
    expect(result).toMatchObject({ ok: true, done: 2 });
    expect(work).toEqual(['matching:in']);
    expect(log.events).toEqual(['begin', 'append:allowed:in', 'commit']);
  });

  test('an entry that cannot be written rolls the set back and says failed', async () => {
    reset();
    log.failNextAllowed();
    await expect(
      runAdminBatch({
        resource: admin.resource('admin_atomic_crates'),
        action: seal,
        ctx: ctx(),
        selection: all,
      }),
    ).rejects.toBeUltimateError('X_ADMIN_INVALID');
    expect(log.events).toEqual(['begin', 'rollback', 'append:failed:out']);
    expect(outcomes()).toEqual(['failed']);
  });
});

describe('unit · a queued batch: every chunk and its entry, or none', () => {
  test('a chunk whose enqueue fails takes the chunks before it back out', async () => {
    reset();
    const queued: string[] = [];
    const enqueue: BatchEnqueue = async (chunk) => {
      if (chunk.index === 2) {
        throw new UltimateError({ code: 'X_ADMIN_INVALID', cause: 'queue down', fix: 'x doctor' });
      }
      queued.push(`${chunk.batchId} ${String(chunk.index)} ${log.inside() ? 'in' : 'out'}`);
      return `job-${String(chunk.index)}`;
    };
    const selection = { kind: 'ids', ids } as const;
    const resource = admin.resource('admin_atomic_crates');
    await expect(
      runAdminBatch({ resource, action: seal, ctx: ctx(), selection, enqueue }),
    ).rejects.toBeUltimateError('X_ADMIN_INVALID');
    expect(queued.every((one) => one.endsWith(' in'))).toBe(true);
    expect(log.events).toEqual(['begin', 'rollback', 'append:failed:out']);

    // The retry derives the SAME batch id: chunks 0 and 1 carry the keys they already held.
    const first = queued.map((one) => one.split(' ')[0] ?? '');
    queued.length = 0;
    await runAdminBatch({
      resource,
      action: seal,
      ctx: admin.ctx({ actor: { id: 'u-op', roles: ['ops'] }, requestId: 'r-2-retry' }),
      selection,
      enqueue: async (chunk) => {
        queued.push(chunk.batchId);
        return `job-${String(chunk.index)}`;
      },
    });
    expect(new Set(queued)).toEqual(new Set(first));
  });

  test('the batch id is derived from actor, action, rows and input — never drawn', () => {
    const base = { resource: admin.resource('admin_atomic_crates'), action: seal, ctx: ctx() };
    const id = batchIdOf(base, ['a', 'b'], {});
    expect(batchIdOf(base, ['a', 'b'], {})).toBe(id);
    expect(batchIdOf(base, ['a', 'c'], {})).not.toBe(id);
    expect(batchIdOf(base, ['a', 'b'], { note: 'x' })).not.toBe(id);
    const other = { ...base, ctx: admin.ctx({ actor: { id: 'u-other' }, requestId: 'r-1' }) };
    expect(batchIdOf(other, ['a', 'b'], {})).not.toBe(id);
    const tenant = {
      ...base,
      ctx: admin.ctx({ actor: { id: 'u-op', orgId: 'org-b' }, requestId: 'r-1' }),
    };
    expect(batchIdOf(tenant, ['a', 'b'], {})).not.toBe(id);
  });
});
