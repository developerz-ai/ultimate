/**
 * contract — a partner's machine against Postly's authorization server and the `/partner` mount,
 * both built the way the boot builds them: `runtime.ts`'s plain routes beside `apiMountRoutes()`.
 * A client-credentials token minted at `POST /oauth/token` opens the public reads and nothing else.
 *
 * Registration happens in `scripts/test-setup.ts`, the preload; this file never imports `api/`.
 */

import { apiMountRoutes } from '@ultimat3/cli';
import { queryPath } from '@ultimat3/core/page';
import { defineHttpConfig, httpServer, mountedPath, type Route } from '@ultimat3/http';
import { expect, test } from '@ultimat3/testing';
import { runtime } from '../../runtime';
import { partnerOAuth, registerPartner } from './oauth';

// The type half of the contract: auth matches http's `Route` by structure, never by import.
const plainRoutes: readonly Route[] = runtime.routes;

const server = () =>
  httpServer({
    routes: [...plainRoutes, ...apiMountRoutes()],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const PUBLIC_POSTS = mountedPath('/partner', queryPath('publicPosts'));
const ORG_KEY_ROUTE = mountedPath('/partner', queryPath('liveRunEvents'));

/** The token request a partner's sync sends, its secret in the `Authorization: Basic` header. */
const mintToken = async (clientId: string, secret: string | null): Promise<Response> =>
  server().fetch(
    new Request('http://dev.test/oauth/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${secret ?? ''}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=posts%3Aread',
    }),
  );

const read = (path: string, token?: string): Promise<Response> =>
  server().fetch(
    new Request(`http://dev.test${path}?limit=5`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );

const accessToken = async (): Promise<{ readonly token: string; readonly clientId: string }> => {
  const { clientId, clientSecret } = await registerPartner({ name: 'Ledger sync' });
  const response = await mintToken(clientId, clientSecret);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly access_token: string };
  return { token: body.access_token, clientId };
};

test('the RFC 8414 document is served and names client_credentials alone', async () => {
  const response = await read('/.well-known/oauth-authorization-server');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    issuer: partnerOAuth.issuer,
    grant_types_supported: ['client_credentials'],
  });
});

test('a client-credentials token reads the public blog through the mount', async () => {
  const { token } = await accessToken();
  const response = await read(PUBLIC_POSTS, token);
  expect(response.status).toBe(200);
});

test('no token, a wrong secret, or a revoked grant opens nothing', async () => {
  expect((await read(PUBLIC_POSTS)).status).toBe(401);

  const { clientId } = await registerPartner({ name: 'Wrong secret' });
  expect((await mintToken(clientId, 'not-the-secret')).status).toBe(401);

  const { token, clientId: revoked } = await accessToken();
  await partnerOAuth.revoke({ subject: revoked, clientId: revoked });
  expect((await read(PUBLIC_POSTS, token)).status).toBe(401);
});

/**
 * A browser-based client posting its credentials in the BODY (`client_secret_post`), cross-origin
 * and with no cookie — no `Authorization` header to exempt it, so this is the request CSRF would
 * judge. The endpoint is client-authenticated and sets no cookie: there is nothing to forge.
 */
test('a cross-origin browser POST with no cookie reaches the token endpoint', async () => {
  const { client, clientSecret } = await partnerOAuth.registerClient({
    name: 'Browser dashboard',
    authMethod: 'client_secret_post',
    grantTypes: ['client_credentials'],
    scopes: ['posts:read'],
  });
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: client.clientId,
    client_secret: clientSecret ?? '',
  });
  const response = await server().fetch(
    new Request('http://dev.test/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://partner.example',
        'sec-fetch-site': 'cross-site',
      },
      body: form.toString(),
    }),
  );
  expect(response.status).toBe(200);
});

test('a partner token is cut to its scopes: an org route is not on its mount', async () => {
  const { token } = await accessToken();
  expect((await read(ORG_KEY_ROUTE, token)).status).toBe(404);
});
