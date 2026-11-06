// Who a client is: an https `client_id` read from its metadata document (size-capped, cached,
// public only, `client_id` must name itself), or an RFC 7591 registration — on only under
// `registration: 'dynamic'`, never for `client_credentials`, and counted per address.

import { describe, expect, test } from 'bun:test';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import {
  authorizeUrl,
  ISSUER,
  pkce,
  REDIRECT,
  serverFixture,
} from './authorization-server-fixture';

const DOC_ID = 'https://client.example/oauth/client.json';
const publicDns = async () => ['93.184.216.34'];

const serving =
  (document: unknown, calls: string[] = []): OutboundFetch =>
  async (url) => {
    calls.push(url);
    return Response.json(document);
  };

const register = async (
  server: Awaited<ReturnType<typeof serverFixture>>['server'],
  body: unknown,
) => {
  const route = server.routes.find((r) => r.path === '/oauth/register');
  if (route === undefined) return expect.unreachable('dynamic registration mounts /oauth/register');
  const raw = new Request(`${ISSUER}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await raw.clone().arrayBuffer());
  const response = await route.handler(
    { raw, bodyBytes: async () => bytes },
    { ip: '198.51.100.7' },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('metadata-document clients', () => {
  test('an https client_id is fetched once, cached, and reads as a public client', async () => {
    const calls: string[] = [];
    const { server } = await serverFixture({
      fetch: serving(
        { client_id: DOC_ID, client_name: 'Doc client', redirect_uris: [REDIRECT] },
        calls,
      ),
      resolveHost: publicDns,
    });
    for (let i = 0; i < 2; i += 1) {
      const read = await server.readRequest(
        authorizeUrl(DOC_ID, pkce().challenge, { scope: 'read' }),
      );
      expect(read.ok && read.request.client.name).toBe('Doc client');
    }
    expect(calls).toHaveLength(1);
  });

  test('a document naming another client_id, or carrying a secret method, is no client', async () => {
    for (const document of [
      { client_id: 'https://evil.test/c.json', redirect_uris: [REDIRECT] },
      {
        client_id: DOC_ID,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      },
      { client_id: DOC_ID, redirect_uris: ['http://evil.test/cb'] },
    ]) {
      const { server } = await serverFixture({ fetch: serving(document), resolveHost: publicDns });
      const read = await server.readRequest(authorizeUrl(DOC_ID, pkce().challenge));
      expect(read).toMatchObject({ ok: false, error: 'invalid_client', redirectTo: null });
    }
  });

  test('a client_id resolving to a private address is never dialled', async () => {
    const calls: string[] = [];
    const { server } = await serverFixture({
      fetch: serving({ client_id: DOC_ID, redirect_uris: [REDIRECT] }, calls),
      resolveHost: async () => ['10.0.0.5'],
    });
    const read = await server.readRequest(authorizeUrl(DOC_ID, pkce().challenge));
    expect(read).toMatchObject({ ok: false, error: 'invalid_client' });
    expect(calls).toHaveLength(0);
  });
});

describe('dynamic registration', () => {
  test('off by default', async () => {
    const { server } = await serverFixture();
    expect(server.routes.some((r) => r.path === '/oauth/register')).toBe(false);
  });

  test('registers a public client that can then authorize', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    const answer = await register(server, {
      client_name: 'Inspector',
      redirect_uris: [REDIRECT],
      scope: 'read',
    });
    expect(answer.status).toBe(201);
    expect(answer.body['client_secret']).toBeUndefined();
    const read = await server.readRequest(
      authorizeUrl(String(answer.body['client_id']), pkce().challenge, { scope: 'read' }),
    );
    expect(read.ok).toBe(true);
  });

  test('refuses client_credentials, bad redirects and unknown scopes', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    for (const body of [
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      { redirect_uris: ['http://evil.test/cb'] },
      { redirect_uris: [`${REDIRECT}#x`] },
      { redirect_uris: [REDIRECT], scope: 'root' },
    ]) {
      expect((await register(server, body)).status).toBe(400);
    }
  });

  test('is rate limited per address', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await register(server, { redirect_uris: [REDIRECT] })).status);
    }
    expect(statuses).toContain(429);
  });
});
