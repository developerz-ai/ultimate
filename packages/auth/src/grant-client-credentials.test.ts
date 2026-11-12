// RFC 6749 §4.4: a machine client's secret buys a short-lived token — refused for a wrong secret
// and for a public client, narrowed to what the request asks within the registered set, and never
// accompanied by a refresh token.

import { describe, expect, test } from 'bun:test';
import { post, serverFixture } from './authorization-server-fixture';

const machine = async () => {
  const fixture = await serverFixture();
  const { client, clientSecret } = await fixture.server.registerClient({
    name: 'Partner sync',
    authMethod: 'client_secret_basic',
    grantTypes: ['client_credentials'],
    scopes: ['read', 'write'],
  });
  const basic = (secret: string) => ({
    authorization: `Basic ${btoa(`${client.clientId}:${secret}`)}`,
  });
  return { fixture, client, secret: clientSecret ?? '', basic };
};

describe('client_credentials', () => {
  test('the right secret buys a token for the client itself, with no refresh token', async () => {
    const { fixture, client, secret, basic } = await machine();
    const answer = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials' },
      basic(secret),
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ expires_in: 300, scope: 'read write' });
    expect(answer.body['refresh_token']).toBeUndefined();
    const resolved = await fixture.server.resolve(String(answer.body['access_token']));
    expect(resolved).toMatchObject({ subject: client.clientId, clientId: client.clientId });
  });

  test('a wrong secret, no secret or the secret in a second method is refused', async () => {
    const { fixture, client, secret, basic } = await machine();
    const wrong = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials' },
      basic(`${secret}x`),
    );
    expect(wrong).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    const none = await post(fixture.server, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: client.clientId,
    });
    expect(none).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    const both = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials', client_secret: secret },
      basic(secret),
    );
    expect(both.body['error']).toBe('invalid_request');
  });

  test('a client_secret_post client is read from the body', async () => {
    const fixture = await serverFixture();
    const { client, clientSecret } = await fixture.server.registerClient({
      name: 'Post sync',
      authMethod: 'client_secret_post',
      grantTypes: ['client_credentials'],
      scopes: ['read'],
    });
    const answer = await post(fixture.server, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: clientSecret ?? '',
    });
    expect(answer.status).toBe(200);
  });

  test('scope narrows within the registered set and never beyond it', async () => {
    const { fixture, secret, basic } = await machine();
    const narrow = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials', scope: 'read' },
      basic(secret),
    );
    expect(narrow.body['scope']).toBe('read');
    const beyond = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials', scope: 'read admin' },
      basic(secret),
    );
    expect(beyond.body['error']).toBe('invalid_scope');
  });

  test('a public client cannot use it', async () => {
    const fixture = await serverFixture();
    const { client } = await fixture.server.registerClient({
      name: 'cli',
      grantTypes: ['client_credentials'],
      scopes: ['read'],
    });
    const answer = await post(fixture.server, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: client.clientId,
    });
    expect(answer.body['error']).toBe('unauthorized_client');
  });

  test("a client registered with no scopes may ask for any of the server's", async () => {
    const fixture = await serverFixture();
    const { clientSecret, client } = await fixture.server.registerClient({
      name: 'Unscoped sync',
      authMethod: 'client_secret_basic',
      grantTypes: ['client_credentials'],
      scopes: [],
    });
    const answer = await post(
      fixture.server,
      '/oauth/token',
      { grant_type: 'client_credentials', scope: 'read' },
      { authorization: `Basic ${btoa(`${client.clientId}:${clientSecret ?? ''}`)}` },
    );
    expect(answer).toMatchObject({ status: 200, body: { scope: 'read' } });
  });
});
