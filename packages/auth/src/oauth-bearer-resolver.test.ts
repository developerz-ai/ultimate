// `oauthBearerResolver`: a live grant becomes a caller only through the app's `actor`, built per
// call, and only when its resource is the one this surface serves — an unbound grant included.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import type { ResolvedGrant } from './authorization-server-types';
import { oauthBearerResolver } from './oauth-bearer-resolver';

const grant = (resource: string | null): ResolvedGrant => ({
  subject: 'user-1',
  scopes: new Set(['read']),
  clientId: 'c1',
  resource,
});
const source = (answer: ResolvedGrant | null) => ({ resolve: async () => answer });
const actor = () => agentActor({ id: 'user-1' });

describe('oauthBearerResolver', () => {
  test('a live grant becomes the actor the app builds, with the granted scopes', async () => {
    const caller = await oauthBearerResolver(source(grant('https://x.test/mcp')), { actor })('t');
    expect(caller?.actor.id).toBe('user-1');
    expect([...(caller?.scopes ?? [])]).toEqual(['read']);
  });

  test('another resource, or none, is refused when the surface names one', async () => {
    const options = { actor, resource: 'https://x.test/mcp' };
    expect(
      await oauthBearerResolver(source(grant('https://x.test/admin')), options)('t'),
    ).toBeNull();
    expect(await oauthBearerResolver(source(grant(null)), options)('t')).toBeNull();
    expect(
      await oauthBearerResolver(source(grant('https://x.test/mcp')), options)('t'),
    ).not.toBeNull();
  });

  test('an actor of null, or no grant, is null', async () => {
    expect(await oauthBearerResolver(source(grant(null)), { actor: () => null })('t')).toBeNull();
    expect(await oauthBearerResolver(source(null), { actor })('t')).toBeNull();
  });
});
