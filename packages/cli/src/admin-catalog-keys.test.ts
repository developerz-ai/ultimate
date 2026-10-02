// The keys the `i18n` step audits for a mounted admin are the ones `defineAdmin` DERIVED — asked of
// the admin, so a resource, a field, a section, a scope, a computed column or an action whose label
// is missing is a finding before an operator sees `⟦admin.orgs.title⟧`.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearAdminMounts, defineAdmin } from '@ultimat3/admin';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { clearRoutes } from '@ultimat3/render';
import { mountedAdminKeys } from './admin-catalog-keys';

const orgs = entity('cli_keys_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }), plan: text({ max: 20 }) },
});

afterAll(() => {
  clearAdminMounts();
  clearRoutes();
  clearRegistry();
});

describe('unit · the keys a mounted admin renders', () => {
  test('no admin mounted reads nothing, and loads nothing', async () => {
    clearRoutes();
    expect(await mountedAdminKeys()).toEqual([]);
  });

  test('resource, group, field, section, scope and column labels, as the admin derived them', async () => {
    const admin = defineAdmin({
      basePath: '/keys-admin',
      entities: [orgs],
      db: database({ orgs }, { driver: memoryDriver() }),
      resources: {
        cli_keys_orgs: {
          sections: [{ titleKey: 'admin.cli_keys_orgs.section.billing', fields: ['plan'] }],
          scopes: { paying: { where: [{ field: 'plan', op: 'eq', value: 'pro' }] } },
          columns: { size: { value: () => 'x', render: 'truncate' } },
        },
      },
    });
    const keys = await mountedAdminKeys();
    for (const key of [
      'admin.cli_keys_orgs.title',
      'admin.group.data',
      'admin.cli_keys_orgs.field.name',
      'admin.cli_keys_orgs.field.plan',
      'admin.cli_keys_orgs.section.billing',
      'admin.section.other',
      'admin.cli_keys_orgs.scope.paying',
      'admin.cli_keys_orgs.column.size',
    ]) {
      expect(keys).toContain(key);
    }
    // Every admin carries the framework's jobs dashboard: its keys are audited like the app's own.
    expect(keys).toContain('admin.group.jobs');
    // An action that names no key is audited under the one its button draws.
    expect(keys).toContain('admin.action.job.retry');
    expect(keys).toEqual(admin.catalogKeys());
  });
});
