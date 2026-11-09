// A write takes only what the resource's form offers: a field declared `readOnly` or `hidden` is
// out of reach for a direct `adminCreate`/`adminUpdate` caller exactly as it is for the HTML form
// (`decodeForm`) and the MCP tool schema (`additionalProperties: false`).

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, newId, text, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { adminAllowed } from './authz';
import { adminCreate, adminUpdate, type CrudCtx } from './crud';
import type { AdminRow } from './registry';
import { adminResource } from './resource';

const accounts = entity('admin_form_field_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 40 }),
    tier: text({ max: 16 }).default('free'),
    note: text({ max: 40 }).default(''),
  },
});

afterAll(clearRegistry);

const store = new Map<string, AdminRow>();
const resource = adminResource(accounts, {
  fields: { tier: { readOnly: true }, note: { hidden: true } },
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
  actor: { id: 'u-op' },
  authz: { decide: ({ permission }) => adminAllowed(permission, 'probe.granted') },
  audit: memoryAuditLog(),
  requestId: 'req-form-fields',
});

describe('unit · a write is cut to the form', () => {
  test('a create naming a readOnly or hidden field writes the default, not the value', async () => {
    const made = await adminCreate(resource, ctx(), {
      name: 'Ada',
      tier: 'enterprise',
      note: 'planted',
    });
    expect(made.ok && made.row).toMatchObject({ name: 'Ada', tier: 'free', note: '' });
  });

  test('an update naming a readOnly or hidden field leaves it as it was', async () => {
    const id = newId();
    store.set(id, { id, name: 'Bo', tier: 'free', note: '' });
    const done = await adminUpdate(resource, ctx(), id, {
      name: 'Bea',
      tier: 'enterprise',
      note: 'planted',
    });
    expect(done.ok).toBe(true);
    expect(store.get(id)).toMatchObject({ name: 'Bea', tier: 'free', note: '' });
  });
});
