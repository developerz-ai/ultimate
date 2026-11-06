// `x db gen` on a flipped `database.rowSecurity`: one policy per tenant table, emitted once (a
// recorded table is skipped), removed when the flag goes off, each with its revert.

import { describe, expect, test } from 'bun:test';
import type { Plan } from './foreign-key-plan';
import { rowSecurityAfter, rowSecurityPlan, type TenantTable } from './row-security-plan';

const TABLES: readonly TenantTable[] = [
  { table: 'posts', column: 'org_id', type: 'uuid' },
  { table: 'invites', column: 'org_id', type: 'uuid' },
];
const fresh = (): Plan => ({ up: [], down: [] });

describe('rowSecurityPlan', () => {
  test('flag on: every unrecorded tenant table gets enable, force, policy and the grant', () => {
    const plan = fresh();
    rowSecurityPlan(plan, {
      enabled: true,
      tenantTables: TABLES,
      recorded: new Set(['invites']),
      appRole: 'x_app',
    });
    expect(plan.up).toHaveLength(4);
    expect(plan.up[0]).toBe('alter table "posts" enable row level security;');
    expect(plan.up[3]).toBe('grant select, insert, update, delete on "posts" to "x_app";');
    expect(plan.down[0]).toBe('alter table "posts" disable row level security;');
    expect(plan.down.at(-1)).toBe('drop policy if exists "ultimate_tenant" on "posts";');
  });

  test('flag on and everything recorded: nothing, so a second x db gen writes no migration', () => {
    const plan = fresh();
    rowSecurityPlan(plan, {
      enabled: true,
      tenantTables: TABLES,
      recorded: new Set(['posts', 'invites']),
    });
    expect(plan).toEqual(fresh());
  });

  test('flag off: every recorded policy is dropped, and down puts it back', () => {
    const plan = fresh();
    const input = { enabled: false, tenantTables: TABLES, recorded: new Set(['posts']) };
    rowSecurityPlan(plan, input);
    expect(plan.up[0]).toBe('drop policy if exists "ultimate_tenant" on "posts";');
    expect(plan.down.at(-1)).toBe('alter table "posts" enable row level security;');
    expect([...rowSecurityAfter(input)]).toEqual([]);
  });
});
