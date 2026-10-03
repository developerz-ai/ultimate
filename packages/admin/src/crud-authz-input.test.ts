// A create and an update are decided on what they WRITE, not only on the row before: the subject a
// policy reads carries `input` — the validated values the row will hold — beside `row`. A rule
// over the written values ("nobody files an invoice as paid") could not fire before, because
// `AdminSubject.input` was declared and never filled.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, newId, text, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminAuthz, type AdminSubject, allowed, denied } from './authz';
import { adminCreate, adminUpdate, type CrudCtx } from './crud';
import type { AdminRow } from './registry';
import { adminResource } from './resource';

const invoices = entity('admin_authz_invoices', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }), state: text({ max: 16 }) },
});

afterAll(clearRegistry);

const seen: AdminSubject[] = [];
/** Every gate granted, except a write whose VALUES say `paid` — a rule only `input` can answer. */
const noPaid: AdminAuthz = {
  decide: ({ permission, subject }) => {
    if (subject !== undefined) seen.push(subject);
    const input = subject?.input as Readonly<Record<string, unknown>> | undefined;
    return input?.['state'] === 'paid'
      ? denied(permission, 'probe.no-paid')
      : allowed(permission, 'probe.granted');
  },
};

const store = new Map<string, AdminRow>();
const resource = adminResource(invoices, {
  repo: {
    list: async () => [...store.values()],
    find: async (id) => store.get(id) ?? null,
    create: async (input) => {
      store.set(String(input['id']), input);
      return input;
    },
    update: async (id, patch) => {
      const next = { ...(store.get(id) ?? {}), ...patch };
      store.set(id, next);
      return next;
    },
    destroy: async (id) => void store.delete(id),
  },
});

const ctx = (): CrudCtx => ({
  actor: { id: 'u-clerk' },
  authz: noPaid,
  audit: memoryAuditLog(),
  requestId: 'req-authz-input',
});

describe('unit · a write is decided on the values it writes', () => {
  test('a create whose values the policy refuses is denied, audited, and never written', async () => {
    const id = newId();
    const refused = await adminCreate(resource, ctx(), { id, title: 'A', state: 'paid' });
    expect(refused).toMatchObject({ ok: false, kind: 'denied' });
    expect(refused.ok === false && refused.audit.outcome).toBe('denied');
    expect(store.has(id)).toBe(false);
    const made = await adminCreate(resource, ctx(), { id, title: 'A', state: 'open' });
    expect(made.ok).toBe(true);
  });

  test('an update is decided on the row before AND the values after', async () => {
    const id = newId();
    store.set(id, { id, title: 'B', state: 'open' });
    seen.length = 0;
    const refused = await adminUpdate(resource, ctx(), id, { state: 'paid' });
    expect(refused).toMatchObject({ ok: false, kind: 'denied' });
    expect(store.get(id)?.['state']).toBe('open');
    // The rule saw both: the stored row, and what the write would leave.
    expect(seen.some((one) => one.row !== undefined && one.input !== undefined)).toBe(true);
    expect((await adminUpdate(resource, ctx(), id, { title: 'B2' })).ok).toBe(true);
  });
});
