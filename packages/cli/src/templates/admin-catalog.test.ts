// The labels a generated entity's admin screen reads. The keys are the ADMIN's derivation —
// `admin.<entity name>.title`, `admin.<entity name>.field.<property>` — so they are checked here
// against a real `defineAdmin()` over an entity of the generated shape, never against a second
// spelling of the formula.

import { describe, expect, test } from 'bun:test';
import { defineAdmin } from '@ultimat3/admin';
import { database, entity, memoryDriver, money, text, timestamp, uuid } from '@ultimat3/entity';
import { generate } from '../cmd-generate';
import { adminCatalogEntries, columnLabel } from './admin-catalog';

const TARGET = { surfaceDir: 'apps/web/app', feature: 'credit-note' };

describe('unit · the admin keys a generated entity ships', () => {
  test('every key defineAdmin() derives for the generated shape is emitted, and no other', () => {
    // The columns `x g entity` writes, under a name no other suite declares.
    const creditNote = entity('admin_catalog_credit_notes', {
      tenant: 'orgId',
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid(),
        title: text({ max: 200 }),
        price: money(),
        createdAt: timestamp().defaultNow(),
      },
    });
    const admin = defineAdmin({
      entities: [creditNote],
      db: database({ notes: creditNote }, { driver: memoryDriver() }),
    });
    const resource = admin.resources[0];
    const derived = [resource?.titleKey ?? '', ...(resource?.fields ?? []).map((f) => f.labelKey)];
    const emitted = Object.keys(adminCatalogEntries('credit-note', TARGET)).map((key) =>
      key.replace('admin.credit_notes.', 'admin.admin_catalog_credit_notes.'),
    );
    expect(emitted.toSorted()).toEqual(derived.toSorted());
  });

  test('the table, not the kebab name, is the key — and labels read as prose', () => {
    const entries = adminCatalogEntries('credit-note', TARGET);
    expect(entries['admin.credit_notes.title']).toBe('Credit notes');
    expect(entries['admin.credit_notes.field.orgId']).toBe('Org ID');
    expect(entries['admin.credit_notes.field.createdAt']).toBe('Created at');
    expect(columnLabel('id')).toBe('ID');
  });

  test('x g entity and x g resource both write them, to every locale asked for', () => {
    for (const kind of ['entity', 'resource'] as const) {
      const files = generate({ kind, name: 'credit-note', locales: ['en', 'es'] });
      for (const locale of ['en', 'es']) {
        const catalog = files.find((file) => file.path === `packages/i18n/catalogs/${locale}.json`);
        const admin = (JSON.parse(String(catalog?.contents)) as { admin: Record<string, unknown> })
          .admin;
        expect(Object.keys(admin)).toEqual(['credit_notes']);
        expect(admin['credit_notes']).toMatchObject({ title: 'Credit notes', field: { id: 'ID' } });
      }
    }
  });
});
