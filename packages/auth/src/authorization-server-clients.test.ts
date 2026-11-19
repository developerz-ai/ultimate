// Who a client is: an https `client_id` read from its metadata document (size-capped, cached,
// public only, `client_id` must name itself), or an RFC 7591 registration — on only under
// `registration: 'dynamic'`, never for `client_credentials`, and counted per address.

import { describe, expect, test } from 'bun:test';
import { frozenClock, stringField } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import {
  authorizeUrl,
  ISSUER,
  pkce,
  post,
  REDIRECT,
  serverFixture,
} from './authorization-server-fixture';
import { DYNAMIC_CLIENT_PREFIX } from './authorization-server-types';
import { memoryAuthLimiter } from './rate-limit';

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
  ip = '198.51.100.7',
) => {
  const route = server.routes.find((r) => r.path === '/oauth/register');
  if (route === undefined) return expect.unreachable('dynamic registration mounts /oauth/register');
  const raw = new Request(`${ISSUER}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await raw.clone().arrayBuffer());
  const response = await route.handler({ raw, bodyBytes: async () => bytes }, { ip });
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

  test("a metadata-document client carries its client_id's host beside the name it chose", async () => {
    const { server, client } = await serverFixture({
      fetch: serving({ client_id: DOC_ID, client_name: 'Acme CLI', redirect_uris: [REDIRECT] }),
      resolveHost: publicDns,
    });
    const read = await server.readRequest(authorizeUrl(DOC_ID, pkce().challenge));
    expect(read.ok && read.request.client).toMatchObject({
      name: 'Acme CLI',
      host: 'client.example',
    });
    expect(client.host).toBeUndefined();
  });

  test('the consent page read meters metadata fetches per caller when it names one', async () => {
    const keys: string[] = [];
    const counted = memoryAuthLimiter(frozenClock(0), {
      maxAttempts: 10,
      windowMs: 60_000,
      lockoutMs: 60_000,
      scope: 'process',
    });
    const { server } = await serverFixture({
      fetch: serving({ client_id: DOC_ID, redirect_uris: [REDIRECT] }),
      resolveHost: publicDns,
      limiter: {
        policy: counted.policy,
        reserve: (key) => {
          keys.push(key);
          return counted.reserve(key);
        },
        refund: (reservation) => counted.refund(reservation),
        recordSuccess: (key) => counted.recordSuccess(key),
        lockedUntil: (key) => counted.lockedUntil(key),
        reset: () => counted.reset(),
      },
    });
    await server.readRequest(authorizeUrl(DOC_ID, pkce().challenge), { callerKey: '203.0.113.9' });
    // A fresh path: the cached document would skip the limiter.
    const second = `${DOC_ID}?v=2`;
    await server.readRequest(authorizeUrl(second, pkce().challenge), {
      callerKey: '2001:db8:1:2::a',
    });
    await server.readRequest(authorizeUrl(`${DOC_ID}?v=3`, pkce().challenge), {
      callerKey: '2001:db8:1:2::b',
    });
    // Keyed by network, as `login` is: two addresses in one /64 are one bucket.
    expect(keys).toEqual([
      'oauth-client-metadata:ip:203.0.113.9',
      'oauth-client-metadata:ip:2001:db8:1:2::/64',
      'oauth-client-metadata:ip:2001:db8:1:2::/64',
    ]);
  });

  test('a consent read naming no caller is metered too, on one shared key', async () => {
    const calls: string[] = [];
    const answering: OutboundFetch = async (url) => {
      calls.push(url);
      return Response.json({ client_id: url, redirect_uris: [REDIRECT] });
    };
    const { server } = await serverFixture({ fetch: answering, resolveHost: publicDns });
    const codes: string[] = [];
    for (let n = 0; n < 200; n += 1) {
      // A fresh path each load: no cache hit, so only the limiter stands between page and fetch.
      const clientId = `https://victim.example/c/${n}`;
      await server.readRequest(authorizeUrl(clientId, pkce().challenge)).catch((error: unknown) => {
        codes.push(stringField(error, 'code') ?? 'uncoded');
      });
    }
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(codes).toHaveLength(200 - calls.length);
    expect(new Set(codes)).toEqual(new Set(['X_ACCOUNT_LOCKED']));
  });

  test('a failing metadata document is asked for once — no vendor retry', async () => {
    const calls: string[] = [];
    const failing: OutboundFetch = async (url) => {
      calls.push(url);
      return new Response('busy', { status: 503 });
    };
    const { server } = await serverFixture({ fetch: failing, resolveHost: publicDns });
    const read = await server.readRequest(authorizeUrl(DOC_ID, pkce().challenge));
    expect(read.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('concurrent misses for one client id share one fetch', async () => {
    const calls: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: OutboundFetch = async (url) => {
      calls.push(url);
      await gate;
      return Response.json({ client_id: DOC_ID, redirect_uris: [REDIRECT] });
    };
    const { server } = await serverFixture({ fetch: slow, resolveHost: publicDns });
    const reads = Array.from({ length: 5 }, () =>
      server.readRequest(authorizeUrl(DOC_ID, pkce().challenge, { scope: 'read' })),
    );
    // Every read joined the first fetch synchronously; the gate only holds that fetch open.
    release();
    const answers = await Promise.all(reads);
    expect(answers.every((one) => one.ok)).toBe(true);
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

  test('an unauthenticated caller cycling client_id paths meets a bounded fetch count', async () => {
    const calls: string[] = [];
    const { server } = await serverFixture({ fetch: serving({}, calls), resolveHost: publicDns });
    const answers: { status: number; body: Record<string, unknown> }[] = [];
    for (let i = 0; i < 15; i += 1) {
      answers.push(
        await post(server, '/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: 'x',
          client_id: `https://victim.example/p${i}`,
        }),
      );
    }
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(answers.at(-1)).toMatchObject({
      status: 429,
      body: { error: 'temporarily_unavailable' },
    });
  });

  test('a full cache evicts its oldest entry, not every entry', async () => {
    const calls: string[] = [];
    const { server } = await serverFixture({ fetch: serving({}, calls), resolveHost: publicDns });
    // One caller per read: this is the cache's bound, not the limiter's — every fetch is metered.
    const read = (n: number) =>
      server.readRequest(authorizeUrl(`https://c.example/d${n}`, pkce().challenge), {
        callerKey: `caller-${n}`,
      });
    for (let i = 0; i <= 1_000; i += 1) await read(i);
    expect(calls).toHaveLength(1_001);
    await read(1);
    expect(calls).toHaveLength(1_001);
    await read(0);
    expect(calls).toHaveLength(1_002);
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

  test('a registration naming more redirect_uris than the cap is invalid_client_metadata, and nothing is stored', async () => {
    const { server, store } = await serverFixture({ registration: 'dynamic' });
    const puts: string[] = [];
    const put = store.putClient.bind(store);
    store.putClient = async (client) => {
      puts.push(client.clientId);
      await put(client);
    };
    const many = Array.from({ length: 11 }, (_, i) => `https://app.test/cb/${i}`);
    const long = `https://app.test/${'a'.repeat(2_048)}`;
    for (const redirect_uris of [many, [long]]) {
      const answer = await register(server, { redirect_uris });
      expect(answer).toMatchObject({ status: 400, body: { error: 'invalid_client_metadata' } });
    }
    expect(puts).toEqual([]);
    expect((await register(server, { redirect_uris: many.slice(0, 10) })).status).toBe(201);
  });

  test('a self-registered client gets the purgeable d_ id; one the app registers keeps c_', async () => {
    const { server, store, client } = await serverFixture({ registration: 'dynamic' });
    const answer = await register(server, { redirect_uris: [REDIRECT], scope: 'read read read' });
    expect(answer.body['scope']).toBe('read');
    const id = String(answer.body['client_id']);
    expect(id.startsWith(DYNAMIC_CLIENT_PREFIX)).toBe(true);
    expect((await store.getClient(id))?.scopes).toEqual(['read']);
    expect(client.clientId.startsWith('c_')).toBe(true);
  });

  test('registrations from many addresses in one /64 share one bucket', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const ip = `2001:db8:1:2::${(i + 1).toString(16)}`;
      statuses.push((await register(server, { redirect_uris: [REDIRECT] }, ip)).status);
    }
    expect(statuses).toContain(429);
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

describe('client screening', () => {
  test('a redirect URI containing whitespace is refused', async () => {
    const { server } = await serverFixture({ registration: 'dynamic' });
    for (const uri of [
      'https://app.test/call back',
      'https://app.test/cb\tx',
      ' https://app.test/cb',
      'https://app.test/cb\n',
    ]) {
      expect((await register(server, { redirect_uris: [uri] })).status).toBe(400);
    }
    expect(
      (await register(server, { redirect_uris: ['https://app.test/call%20back'] })).status,
    ).toBe(201);
  });

  test('a client_secret_basic client presenting its secret in the body is invalid_client', async () => {
    const { server } = await serverFixture();
    const basic = await server.registerClient({
      name: 'Basic sync',
      authMethod: 'client_secret_basic',
      grantTypes: ['client_credentials'],
      scopes: ['read'],
    });
    const inBody = await post(server, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: basic.client.clientId,
      client_secret: basic.clientSecret ?? '',
    });
    expect(inBody).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    const bodied = await server.registerClient({
      name: 'Post sync',
      authMethod: 'client_secret_post',
      grantTypes: ['client_credentials'],
      scopes: ['read'],
    });
    const inHeader = await post(
      server,
      '/oauth/token',
      { grant_type: 'client_credentials' },
      { authorization: `Basic ${btoa(`${bodied.client.clientId}:${bodied.clientSecret ?? ''}`)}` },
    );
    expect(inHeader).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
  });
});
