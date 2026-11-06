// The provider row security reads at every BEGIN: the actor's tenant, `x.cross` inside a proven
// `crossTenant()` scope, and nothing at all with no tenant — which the policy reads as no rows.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from './cross-tenant';
import { rowSecuritySettings } from './row-security-settings';

const ORG = '00000000-0000-4000-8000-00000000000a';

describe('rowSecuritySettings', () => {
  test('the actor`s org is x.tenant', () => {
    const actor = userActor({ id: 'u1', orgId: ORG });
    expect(runWithContext(ctxOf({ actor }), () => rowSecuritySettings())).toEqual({
      'x.tenant': ORG,
    });
  });

  test('inside crossTenant() it is x.cross, never a tenant', () => {
    const actor = { ...userActor({ id: 'u1', orgId: ORG }), scopes: [CROSS_TENANT_SCOPE] };
    const settings = runWithContext(ctxOf({ actor }), () =>
      crossTenant('the test sweeps every org', () => rowSecuritySettings()),
    );
    expect(settings).toEqual({ 'x.cross': 'on' });
  });

  test('no context, or an actor in no org: nothing to set', () => {
    expect(rowSecuritySettings()).toBeUndefined();
    const actor = userActor({ id: 'u1' });
    expect(runWithContext(ctxOf({ actor }), () => rowSecuritySettings())).toBeUndefined();
  });
});
