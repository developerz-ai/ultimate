import { describe, expect, test } from 'bun:test';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import { adminDestroy, adminUpdate, type CrudCtx } from './crud';
import type { AdminEntity, AdminRow } from './registry';
import { type AdminResource, adminResource } from './resource';

const entity: AdminEntity = {
  name: 'post',
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'varchar', index: true },
    secret: { type: 'varchar', sensitive: true, nullable: true },
    createdAt: { type: 'timestamptz', generated: true },
  },
};

function bound(store: Map<string, AdminRow>): AdminResource<AdminRow> {
  return adminResource(entity, {
    repo: {
      list: async (): Promise<readonly AdminRow[]> => [...store.values()],
      find: async (id: string): Promise<AdminRow | null> => store.get(id) ?? null,
      create: async (input): Promise<AdminRow> => {
        store.set(String(input['id']), input);
        return input;
      },
      update: async (id, patch): Promise<AdminRow> => {
        const next = { ...(store.get(id) ?? {}), ...patch };
        store.set(id, next);
        return next;
      },
      destroy: async (id): Promise<void> => void store.delete(id),
    },
  });
}

const actor: AdminActor = { id: 'u_1', roles: ['admin'] };

const ctxWith = (grants: readonly string[]): CrudCtx => ({
  actor,
  authz: staticAuthz(grants),
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

describe('admin mutations are audited with a before/after diff', () => {
  test('update logs exactly the fields that changed', async () => {
    const store = new Map<string, AdminRow>([
      ['p_1', { id: 'p_1', title: 'Draft', secret: 'old', createdAt: '2026-07-01T00:00:00.000Z' }],
    ]);
    const ctx = ctxWith(['admin:write', 'post:write']);
    const result = await adminUpdate(bound(store), ctx, 'p_1', {
      title: 'Published',
      secret: 'new',
    });

    expect(result.ok).toBe(true);
    const entry = ctx.audit.entries()[0];
    expect(entry?.operation).toBe('update');
    expect(entry?.entityId).toBe('p_1');
    expect(entry?.actor.id).toBe('u_1');
    expect(entry?.requestId).toBe('req_1');
    expect(entry?.diff).toEqual([
      { field: 'secret', before: '[redacted]', after: '[redacted]' },
      { field: 'title', before: 'Draft', after: 'Published' },
    ]);
  });

  test('a denied update writes nothing and still leaves a record', async () => {
    const store = new Map<string, AdminRow>([['p_1', { id: 'p_1', title: 'Draft' }]]);
    const ctx = ctxWith(['admin:read']);
    const result = await adminUpdate(bound(store), ctx, 'p_1', { title: 'Hijacked' });

    expect(result.ok).toBe(false);
    expect(store.get('p_1')).toEqual({ id: 'p_1', title: 'Draft' });
    expect(ctx.audit.entries()[0]?.outcome).toBe('denied');
  });
});

describe('destructive operations re-confirm', () => {
  test('delete without the confirmation token is refused and logged', async () => {
    const store = new Map<string, AdminRow>([['p_1', { id: 'p_1', title: 'Draft' }]]);
    const ctx = ctxWith(['admin:destroy', 'post:delete']);
    const refused = await adminDestroy(bound(store), ctx, 'p_1', undefined);

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.kind === 'denied') {
      expect(refused.confirmationRequired).toBe(true);
      expect(refused.decision.reason).toBe('admin.error.confirmation-required');
    }
    expect(store.has('p_1')).toBe(true);
    expect(ctx.audit.entries()[0]?.outcome).toBe('denied');
  });

  test('delete with the token removes the row and logs the before state', async () => {
    const store = new Map<string, AdminRow>([['p_1', { id: 'p_1', title: 'Draft' }]]);
    const ctx = ctxWith(['admin:destroy', 'post:delete']);
    const result = await adminDestroy(bound(store), ctx, 'p_1', 'post:p_1');

    expect(result.ok).toBe(true);
    expect(store.has('p_1')).toBe(false);
    const entry = ctx.audit.entries()[0];
    expect(entry?.outcome).toBe('allowed');
    expect(entry?.diff).toEqual([
      { field: 'id', before: 'p_1', after: undefined },
      { field: 'title', before: 'Draft', after: undefined },
    ]);
  });
});
