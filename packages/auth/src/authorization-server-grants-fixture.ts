// Single responsibility: the one walk over a person's grants both authorization-server stores run —
// two on one client, listed, one revoked by id, the other refreshed after — so the memory and
// Postgres answers cannot drift. Test-only: excluded from the published files (`*-fixture.ts`) and
// absent from `index.ts`.

import { expect } from 'bun:test';
import type { AuthorizationServer } from './authorization-server';
import { post, type ServerFixture, tokensFor } from './authorization-server-fixture';

/** `authorizationServer()` sets both; they are optional only in the type (`AuthorizationServer`). */
export function grantMethods(server: AuthorizationServer) {
  const { grants, revokeGrant } = server;
  if (grants === undefined || revokeGrant === undefined) {
    return expect.unreachable('authorizationServer() sets grants and revokeGrant');
  }
  return { grants, revokeGrant };
}

const refresh = (fixture: ServerFixture, token: unknown) =>
  post(fixture.server, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: String(token),
    client_id: fixture.client.clientId,
  });

export async function oneGrantRevokedCase(fixture: ServerFixture): Promise<void> {
  const { server } = fixture;
  const { grants, revokeGrant } = grantMethods(server);
  const first = await tokensFor(fixture);
  fixture.clock.advance(1000);
  const second = await tokensFor(fixture);
  const firstId = (await server.resolve(String(first.body['access_token'])))?.grantId ?? '';
  const secondId = (await server.resolve(String(second.body['access_token'])))?.grantId ?? '';
  expect(firstId).toStartWith('g_');
  expect(secondId).toStartWith('g_');
  expect(firstId).not.toBe(secondId);

  // A rotation keeps the grant's id, so a revoke by that id still reaches the rotated tokens.
  const rotated = await refresh(fixture, first.body['refresh_token']);
  expect((await server.resolve(String(rotated.body['access_token'])))?.grantId).toBe(firstId);
  expect((await grants({ subject: 'user-1' })).map((grant) => grant.grantId)).toEqual([
    firstId,
    secondId,
  ]);
  expect(await grants({ subject: 'user-2' })).toEqual([]);

  // Another subject's id is not found: nothing revoked, the same answer as an unknown id.
  expect(await revokeGrant({ subject: 'user-2', grantId: firstId })).toBe(0);
  expect(await revokeGrant({ subject: 'user-1', grantId: 'g_unknown' })).toBe(0);
  expect(await server.resolve(String(rotated.body['access_token']))).not.toBeNull();

  expect(await revokeGrant({ subject: 'user-1', grantId: firstId })).toBe(1);
  expect(await revokeGrant({ subject: 'user-1', grantId: firstId })).toBe(0);
  expect(await server.resolve(String(rotated.body['access_token']))).toBeNull();
  expect((await refresh(fixture, rotated.body['refresh_token'])).body['error']).toBe(
    'invalid_grant',
  );

  expect((await server.resolve(String(second.body['access_token'])))?.grantId).toBe(secondId);
  const secondRefreshed = await refresh(fixture, second.body['refresh_token']);
  expect(secondRefreshed.status).toBe(200);
  const listed = await grants({ subject: 'user-1', clientId: fixture.client.clientId });
  expect(listed).toEqual([
    {
      grantId: secondId,
      clientId: fixture.client.clientId,
      scopes: ['read', 'write'],
      resource: 'https://as.test/mcp',
      createdAt: new Date(fixture.clock.now().getTime()),
      refreshedAt: new Date(fixture.clock.now().getTime()),
    },
  ]);
  expect(await grants({ subject: 'user-1', clientId: 'c_other' })).toEqual([]);
}
