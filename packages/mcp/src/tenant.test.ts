// Tests for the per-call tenant mechanics. Each guard is shown by mutation: delete the
// spread/freeze/kind-check it pins and the test fails — none passes by ordering.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/core';
import { buildTenantActor, stripTenantArgs } from './tenant';
import type { McpTenantOption } from './tenant';

const actor = agentActor({
  id: 'agent-1',
  orgId: 'org-a',
  roles: ['editor'],
  permissions: ['post:publish'],
});

describe('stripTenantArgs', () => {
  const option: McpTenantOption = {
    arg: 'tenant',
    resolve: (who: Actor, id: string) => (id === 'org-a' ? { orgId: 'org-a' } : undefined),
  };

  test('drops exactly the configured arg, keeps everything else untouched', () => {
    const stripped = stripTenantArgs({ tenant: 'org-b', title: 'hi', n: 1 }, option);
    expect(stripped.value).toBe('org-b');
    expect(stripped.rest).toEqual({ title: 'hi', n: 1 });
    expect('tenant' in stripped.rest).toBe(false);
  });

  test('undefined arguments survive as an empty rest, not a crash', () => {
    const stripped = stripTenantArgs(undefined, option);
    expect(stripped.value).toBeUndefined();
    expect(stripped.rest).toEqual({});
  });

  test('an absent arg reads as absent — the server refuses it, never undefined-as-value', () => {
    expect(stripTenantArgs({}, option).value).toBeUndefined();
  });
});

describe('buildTenantActor', () => {
  test('re-points orgId and preserves kind, id, roles, permissions and scopes', () => {
    const rebuilt = buildTenantActor(actor, { orgId: 'org-b' });
    expect(rebuilt.orgId).toBe('org-b');
    expect(rebuilt.kind).toBe('agent');
    expect(rebuilt.id).toBe('agent-1');
    expect(rebuilt.roles).toEqual(['editor']);
    expect(rebuilt.permissions).toEqual(['post:publish']);
    expect(rebuilt.scopes).toEqual(actor.scopes);
  });

  test('the rebuilt actor is frozen - no handler rewrites the next call authority', () => {
    const rebuilt = buildTenantActor(actor, { orgId: 'org-b' });
    expect(Object.isFrozen(rebuilt)).toBe(true);
  });

  test('the original actor is untouched — no cross-call bleed', () => {
    buildTenantActor(actor, { orgId: 'org-b' });
    expect(actor.orgId).toBe('org-a');
  });

  test('only an agent is re-tenantable: a human actor is not a token to re-point', () => {
    const human = { ...actor, kind: 'user' as const };
    expect(() => buildTenantActor(human, { orgId: 'org-b' })).toThrow(
      "buildTenantActor: only agents carry tenants, got kind 'user'",
    );
  });
});
