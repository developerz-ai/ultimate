// The `global` verdict through a real pass on the memory driver: a query whose every statement reads
// an `entity({ global })` table comes out `global` with the declared reason, and the same query over
// a tenantless table that declares nothing keeps today's `unproven`.

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/action';
import { entity, text, uuid } from '@ultimat3/entity';
import { can, definePermissions } from '@ultimat3/policy';
import { from, query } from '@ultimat3/query';
import { registerQueries } from '@ultimat3/query/loader';
import { proveOne, resetTenantApp, tpDriver, tpOrgs, tpVaults } from './tenant-proof-fixture';
import { testName } from './test-types';

// Declared in `beforeAll`, never at module scope: the registry guard keeps what a file's MODULE
// scope declared for every later file on a shared worker; here it is this file's own, undone at
// its end.
beforeAll(() => {
  definePermissions(['tp:read', 'tp:write']);
});

const CATALOG_REASON = 'the plan catalog: the same rows for every org';

const tpgPlans = entity('tpg_plans', {
  global: CATALOG_REASON,
  columns: { id: uuid().primaryKey(), code: text({ max: 40 }) },
});

/** Tenantless and undeclared: the exercise cannot tell it from a forgotten tenant column. */
const tpgNotes = entity('tpg_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 40 }) },
});

const ENTITIES = { tpOrgs, tpVaults, tpgPlans, tpgNotes } as const;
const Empty = t.object({});

registerQueries({
  tpgPlanCatalog: query({
    input: Empty,
    policy: can('tp:read'),
    sql: () =>
      from<{ id: string; code: string }>('tpg_plans', async () => {
        const page = await tpDriver.repo(tpgPlans).findMany({ limit: 10 });
        return page.rows.map((row) => ({ id: row.id, code: row.code }));
      }),
  }),
  tpgNoteList: query({
    input: Empty,
    policy: can('tp:read'),
    sql: () =>
      from<{ id: string; body: string }>('tpg_notes', async () => {
        const page = await tpDriver.repo(tpgNotes).findMany({ limit: 10 });
        return page.rows.map((row) => ({ id: row.id, body: row.body }));
      }),
  }),
});

beforeEach(resetTenantApp);

describe(testName('unit', 'tenant proof pass: a read over a global entity'), () => {
  test('a query reading only a global entity is global, with its reason', async () => {
    const record = await proveOne('tpgPlanCatalog', ENTITIES);
    expect(record.outcome).toBe('reached');
    expect(record.tenant?.verdict).toBe('global');
    expect(
      record.tenant !== undefined && 'reason' in record.tenant ? record.tenant.reason : '',
    ).toContain(`tpg_plans: ${CATALOG_REASON}`);
  });

  test('the same read over an undeclared tenantless entity stays unproven', async () => {
    const record = await proveOne('tpgNoteList', ENTITIES);
    expect(record.outcome).toBe('reached');
    expect(record.tenant?.verdict).toBe('unproven');
  });
});
