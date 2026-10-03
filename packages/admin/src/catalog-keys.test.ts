// `app.catalogKeys()` is the one list of keys a declaration derives: an action's default label, its
// form's field labels and the branding's name included — the keys the `i18n` step audits, so a
// label only a renderer spelled could not be asked of a catalog.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { actionLabelKey } from './action-label';
import type { AdminApp } from './admin';
import { defineAdmin } from './admin';
import { clearAdminMounts } from './mounts';

const shelf = entity('admin_keys_shelf', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }), plan: text({ max: 20 }) },
});

afterAll(() => {
  clearAdminMounts();
  clearRegistry();
});

let admin: AdminApp;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/catalog-keys',
    entities: [shelf],
    db: database({ shelf }, { driver: memoryDriver() }),
    branding: { nameKey: 'admin.keys.brand' },
    resources: {
      admin_keys_shelf: {
        sections: [{ titleKey: 'admin.admin_keys_shelf.section.billing', fields: ['plan'] }],
        scopes: { paying: { where: [{ field: 'plan', op: 'eq', value: 'pro' }] } },
        columns: { size: { value: () => 'x', render: 'truncate' } },
      },
    },
    actions: [
      {
        name: 'shelf.restock',
        entity: 'admin_keys_shelf',
        permission: 'admin_keys_shelf:update',
        input: t.object({ count: t.number }),
        handle: async () => null,
      },
      {
        name: 'shelf.audit',
        permission: 'admin:read',
        labelKey: 'admin.keys.audit-everything',
        handle: async () => null,
      },
    ],
  });
});

describe('unit · the keys an admin renders, derived once', () => {
  test('an action with no labelKey is audited under the key its button draws', () => {
    const keys = admin.catalogKeys();
    expect(keys).toContain('admin.action.shelf.restock');
    expect(keys).toContain('admin.keys.audit-everything');
    expect(keys).not.toContain('admin.action.shelf.audit');
    // The framework's own jobs actions are declared like any app's, and audited like one.
    expect(keys).toContain('admin.action.job.retry');
  });

  test("an action's form fields, the branding and every derived label", () => {
    const keys = admin.catalogKeys();
    for (const key of [
      'admin.input.shelf.restock.count',
      'admin.input.job.retry-from-step.step',
      'admin.keys.brand',
      'admin.admin_keys_shelf.title',
      'admin.group.data',
      'admin.group.jobs',
      'admin.admin_keys_shelf.field.name',
      'admin.admin_keys_shelf.section.billing',
      'admin.section.other',
      'admin.admin_keys_shelf.scope.paying',
      'admin.admin_keys_shelf.column.size',
      'admin.dashboard.title',
    ]) {
      expect(keys).toContain(key);
    }
  });

  test('sorted and distinct', () => {
    const keys = admin.catalogKeys();
    expect([...keys]).toEqual([...new Set(keys)].sort());
  });

  test('the label key is the one function every renderer reads', () => {
    expect(actionLabelKey({ name: 'a.b' })).toBe('admin.action.a.b');
    expect(actionLabelKey({ name: 'a.b', labelKey: 'admin.own' })).toBe('admin.own');
  });
});
