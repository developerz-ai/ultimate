// The admin override a resource generator writes. Its list columns are read off the ENTITY the
// same run writes — so a column renamed in the entity template is a column renamed here, and the
// two cannot ship apart.

import { describe, expect, test } from 'bun:test';
import { adminFiles, adminListFields } from './admin';
import { entityFiles } from './entity';

const target = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;

const fileOf = (suffix: string): string =>
  String(adminFiles('invoice', target).find((file) => file.path.endsWith(suffix))?.contents ?? '');

/** Every `name: builder(` under `columns:` in the entity the generator emits. */
const entityColumns = (): readonly string[] => {
  const source = String(
    entityFiles('invoice', target).find((file) => file.path.endsWith('/entity.ts'))?.contents,
  );
  return [...source.matchAll(/^ {4}([A-Za-z_$][\w$]*): [A-Za-z_$][\w$]*\(/gm)].map(
    (line) => line[1] ?? '',
  );
};

describe('unit · x g resource --admin', () => {
  test('the list fields are columns of the entity this same run writes — never a second list', () => {
    const columns = entityColumns();
    const listed = adminListFields('invoice', target);
    expect(columns.length).toBeGreaterThan(2);
    expect(listed.length).toBeGreaterThan(0);
    for (const field of listed) expect(columns).toContain(field);
  });

  test('the key and the tenant column are left out: the list links by id and shows one tenant', () => {
    const listed = adminListFields('invoice', target);
    expect(listed).not.toContain('id');
    expect(listed).not.toContain('orgId');
    // Everything else the entity declares, in its own order.
    expect(listed).toEqual(entityColumns().filter((name) => name !== 'id' && name !== 'orgId'));
  });

  test('the override carries exactly those names, and says where it is wired', () => {
    const source = fileOf('admin/resource.ts');
    const listed = adminListFields('invoice', target);
    expect(source).toContain(`listFields: [${listed.map((name) => `'${name}'`).join(', ')}],`);
    expect(source).toContain('invoiceAdminResource');
    // The table name is the key `resources:` takes — the entity's `$name`, not the feature's.
    expect(source).toContain('resources: { invoices: … }');
    expect(source).toContain('/admin/invoices');
    // No title key: the admin's own default is `admin.<table>.title`, which is the key the
    // generator writes into the catalog — a second spelling here rendered as a missing key.
    expect(source).not.toContain('titleKey');
    expect(fileOf('admin/resource.test.ts')).not.toContain('titleKey');
  });

  test('the emitted test checks the override against the ENTITY, not against itself', () => {
    const test = fileOf('admin/resource.test.ts');
    expect(test).toContain("import { invoice } from '../entity';");
    expect(test).toContain('Object.keys(invoice.$columns)');
  });

  test('both files land beside the slice', () => {
    expect(adminFiles('invoice', target).map((file) => file.path)).toEqual([
      'apps/web/app/invoice/admin/resource.ts',
      'apps/web/app/invoice/admin/resource.test.ts',
    ]);
  });
});
