// RFC 7009 and RFC 7662: a revoked token is dead on the next lookup, an unknown one still answers
// 200; introspection needs a confidential client and reports `{ active: false }`, nothing else,
// for a token neither issued to it nor bound to a resource it serves.

import { describe, expect, test } from 'bun:test';
import { post, RESOURCE, serverFixture, tokensFor } from './authorization-server-fixture';

const resourceServer = async (
  fixture: Awaited<ReturnType<typeof serverFixture>>,
  resources: string[],
) => {
  const { client, clientSecret } = await fixture.server.registerClient({
    name: 'resource server',
    authMethod: 'client_secret_post',
    grantTypes: [],
    resources,
  });
  return { client_id: client.clientId, client_secret: clientSecret ?? '' };
};

describe('revocation', () => {
  test('a revoked token is dead at once, its refresh token with it', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const answer = await post(fixture.server, '/oauth/revoke', {
      token: String(tokens.body['access_token']),
      client_id: fixture.client.clientId,
    });
    expect(answer).toEqual({ status: 200, body: {} });
    expect(await fixture.server.resolve(String(tokens.body['access_token']))).toBeNull();
    const refreshed = await post(fixture.server, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: String(tokens.body['refresh_token']),
      client_id: fixture.client.clientId,
    });
    expect(refreshed.body['error']).toBe('invalid_grant');
  });

  test('an unknown token answers 200; another client cannot revoke yours', async () => {
    const fixture = await serverFixture();
    expect(
      await post(fixture.server, '/oauth/revoke', {
        token: 'xat_nope',
        client_id: fixture.client.clientId,
      }),
    ).toEqual({ status: 200, body: {} });
    const tokens = await tokensFor(fixture);
    const other = await fixture.server.registerClient({ name: 'other', redirectUris: [] });
    await post(fixture.server, '/oauth/revoke', {
      token: String(tokens.body['access_token']),
      client_id: other.client.clientId,
    });
    expect(await fixture.server.resolve(String(tokens.body['access_token']))).not.toBeNull();
  });
});

describe('introspection', () => {
  test('the resource server a token is bound to sees it active', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const rs = await resourceServer(fixture, [RESOURCE]);
    const answer = await post(fixture.server, '/oauth/introspect', {
      token: String(tokens.body['access_token']),
      ...rs,
    });
    expect(answer.body).toMatchObject({
      active: true,
      sub: 'user-1',
      aud: RESOURCE,
      scope: 'read write',
    });
  });

  test("another resource's token is active: false and nothing else", async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const rs = await resourceServer(fixture, ['https://as.test/other']);
    const answer = await post(fixture.server, '/oauth/introspect', {
      token: String(tokens.body['access_token']),
      ...rs,
    });
    expect(answer.body).toEqual({ active: false });
  });

  test('a revoked token is active: false; a public client may not introspect', async () => {
    const fixture = await serverFixture();
    const tokens = await tokensFor(fixture);
    const rs = await resourceServer(fixture, [RESOURCE]);
    await fixture.server.revoke({ subject: 'user-1' });
    const dead = await post(fixture.server, '/oauth/introspect', {
      token: String(tokens.body['access_token']),
      ...rs,
    });
    expect(dead.body).toEqual({ active: false });
    const publicCaller = await post(fixture.server, '/oauth/introspect', {
      token: String(tokens.body['access_token']),
      client_id: fixture.client.clientId,
    });
    expect(publicCaller.status).toBe(401);
  });
});
