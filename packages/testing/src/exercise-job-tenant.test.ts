// The job-tenant binder alone: whatever field a job's `tenant(input)` reads — any name, nested, absent
// from the draw — is set to the seated tenant; a `'none'` job is left alone; a constant org is
// `fixed`, never a guess.

import { describe, expect, test } from 'bun:test';
import { assert } from '@ultimat3/core';
import { bindJobTenant, type TenantOf } from './exercise-job-tenant';
import { testName } from './test-types';

const SEATED = '0b6f8a52-56a4-4f0e-8a4c-1f1b3c0d9e21';
const DRAWN = '9d1c7e4a-2b3f-4a5d-8e6f-7a8b9c0d1e2f';

/** `jobTenantFor`'s shape: `'none'` never calls, an empty answer throws. */
const handle = (tenant: ((input: never) => unknown) | 'none'): TenantOf => ({
  name: 'aJob',
  tenantFor: (input) => {
    if (tenant === 'none') return undefined;
    const org = tenant(input as never);
    assert(typeof org === 'string' && org.length > 0, 'empty tenant', 'return the org id');
    return org;
  },
});

describe(testName('unit', 'bindJobTenant'), () => {
  test('a field of any name is set to the seated tenant, the rest left as drawn', () => {
    const job = handle((input: { workspace: string }) => input.workspace);
    const bound = bindJobTenant(job, { workspace: DRAWN, title: 'x' }, SEATED);
    expect(bound).toEqual({ kind: 'seated', input: { workspace: SEATED, title: 'x' } });
  });

  test('a nested field, and one the minimal draw left out, are found by reading them', () => {
    const nested = handle((input: { scope: { org: string } }) => input.scope.org);
    expect(bindJobTenant(nested, { scope: { org: DRAWN, keep: 1 } }, SEATED)).toEqual({
      kind: 'seated',
      input: { scope: { org: SEATED, keep: 1 } },
    });
    const optional = handle((input: { orgId?: string }) => input.orgId);
    expect(bindJobTenant(optional, {}, SEATED)).toEqual({
      kind: 'seated',
      input: { orgId: SEATED },
    });
  });

  test('an input already naming the tenant, and a tenant: none job, come back as given', () => {
    const input = { orgId: SEATED };
    const named = bindJobTenant(
      handle((one: { orgId: string }) => one.orgId),
      input,
      SEATED,
    );
    expect(named).toEqual({ kind: 'seated', input });
    expect(bindJobTenant(handle('none'), { orgId: DRAWN }, SEATED)).toEqual({
      kind: 'seated',
      input: { orgId: DRAWN },
    });
  });

  test('a field read and ignored is not bound', () => {
    const job = handle((input: { orgId: string; region: string }) =>
      input.region.length > 0 ? input.orgId : '',
    );
    expect(bindJobTenant(job, { orgId: DRAWN, region: 'eu' }, SEATED)).toEqual({
      kind: 'seated',
      input: { orgId: SEATED, region: 'eu' },
    });
  });

  test('a constant org is fixed: no field of the input moves it', () => {
    const job = handle(() => 'platform');
    expect(bindJobTenant(job, { orgId: DRAWN }, SEATED)).toEqual({
      kind: 'fixed',
      declared: 'platform',
    });
  });
});
