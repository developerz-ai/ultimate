// A remote MCP client, from nothing to a `tools/call`, against ONE `mcpAuthorizationServer`: the
// 401 names the protected-resource document, that names the issuer, the issuer's RFC 8414 document
// names registration and the token endpoint, the person consents, the code is exchanged, the
// token calls the tool — and a partner's machine client and a removed member, on the same server.

import { describe, expect, test } from 'bun:test';
import { DEVICE_GRANT, memoryAuthServerStore } from '@ultimat3/auth';
import { agentActor, frozenClock, structuredLogger } from '@ultimat3/core';
import { type McpAuthorizationServer, mcpAuthorizationServer } from './oauth-server';
import { textResult } from './registry';
import { mcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const ISSUER = 'https://www.example.test';
const MCP = `${ISSUER}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

const server = mcpServer({
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return textResult('pong');
      },
    },
  ],
});

const build = (members: Set<string>, lines: string[] = []) => {
  const as = mcpAuthorizationServer({
    issuer: ISSUER,
    resource: MCP,
    store: memoryAuthServerStore(),
    consentPath: '/oauth/consent',
    devicePath: '/oauth/device',
    lifetimes: { accessSeconds: 600, refreshIdleDays: 30, clientSeconds: 300 },
    scopes: ['tools:call'],
    registration: 'dynamic',
    grants: ['authorization_code', 'refresh_token', 'client_credentials', DEVICE_GRANT],
    clock: frozenClock('2026-11-06T09:00:00.000Z'),
    actor: (grant) => (members.has(grant.subject) ? agentActor({ id: grant.subject }) : null),
    log: structuredLogger({
      writer: (line) => lines.push(String(JSON.parse(line).msg)),
    }),
  });
  const route = mcpHttpRoute({ server, resolveToken: as.resolveToken, oauth: as.oauth });
  return { as, route };
};

const handlerOf = (as: McpAuthorizationServer, method: string, path: string) => {
  const found = as.routes.find((r) => r.method === method && r.path === path);
  if (found === undefined) return expect.unreachable(`no ${method} ${path}`);
  return found.handler;
};

const send = async (
  as: McpAuthorizationServer,
  path: string,
  body: string,
  type: string,
  headers: Record<string, string> = {},
) => {
  const raw = new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: { 'content-type': type, ...headers },
    body,
  });
  const bytes = new Uint8Array(await raw.clone().arrayBuffer());
  const response = await handlerOf(
    as,
    'POST',
    path,
  )({ raw, bodyBytes: async () => bytes }, { ip: '127.0.0.1' });
  return (await response.json()) as Record<string, unknown>;
};

const call = (route: ReturnType<typeof build>['route'], token?: string) =>
  route.handle(
    new Request(MCP, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: {} },
      }),
    }),
  );

describe('mcpAuthorizationServer · a client connects from the 401', () => {
  test('discover → register → consent → exchange → tools/call', async () => {
    const lines: string[] = [];
    const { as, route } = build(new Set(['user-1']), lines);

    const unauthorized = await call(route);
    expect(unauthorized.status).toBe(401);
    const challenge = unauthorized.headers.get('www-authenticate') ?? '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadataUrl).toBe(`${ISSUER}/.well-known/oauth-protected-resource/mcp`);
    const prm = route.protectedResource?.document(ISSUER) ?? {};
    expect(prm['authorization_servers']).toEqual([ISSUER]);

    const asDoc = await (
      await handlerOf(
        as,
        'GET',
        '/.well-known/oauth-authorization-server',
      )({ raw: new Request(ISSUER), bodyBytes: async () => new Uint8Array() }, { ip: null })
    ).json();
    expect(asDoc).toMatchObject({
      issuer: ISSUER,
      registration_endpoint: `${ISSUER}/oauth/register`,
    });

    const registered = await send(
      as,
      '/oauth/register',
      JSON.stringify({ client_name: 'Desktop', redirect_uris: [REDIRECT] }),
      'application/json',
    );
    const clientId = String(registered['client_id']);

    const verifier = 'v'.repeat(64);
    const digest = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${ISSUER}/oauth/consent`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: digest,
      code_challenge_method: 'S256',
      scope: 'tools:call',
      state: 's',
    })) {
      authorize.searchParams.set(key, value);
    }
    const read = await as.readRequest(authorize);
    if (!read.ok) return expect.unreachable(`consent refused: ${read.error}`);
    // No `resource` sent: the wrapper binds it to the endpoint anyway.
    expect(read.request.resource).toBe(MCP);
    const back = new URL(await as.approve({ subject: 'user-1', request: read.request }));
    expect(back.searchParams.get('iss')).toBe(ISSUER);

    const tokens = await send(
      as,
      '/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      }).toString(),
      'application/x-www-form-urlencoded',
    );
    const answer = await call(route, String(tokens['access_token']));
    expect(answer.status).toBe(200);
    expect(JSON.stringify(await answer.json())).toContain('pong');
    expect(lines).toContain('mcp.auth.issued');
  });

  test('a partner machine client authenticates against the same server', async () => {
    const members = new Set<string>();
    const { as, route } = build(members);
    const { client, clientSecret } = await as.registerClient({
      name: 'Partner',
      authMethod: 'client_secret_basic',
      grantTypes: ['client_credentials'],
      scopes: ['tools:call'],
    });
    const tokens = await send(
      as,
      '/oauth/token',
      'grant_type=client_credentials',
      'application/x-www-form-urlencoded',
      { authorization: `Basic ${btoa(`${client.clientId}:${clientSecret}`)}` },
    );
    expect(tokens['refresh_token']).toBeUndefined();
    // The app's `actor` decides what the client is: not yet a member, refused per call.
    expect((await call(route, String(tokens['access_token']))).status).toBe(401);
    members.add(client.clientId);
    expect((await call(route, String(tokens['access_token']))).status).toBe(200);
  });

  test('a removed member loses access on the next call, with no sweep', async () => {
    const members = new Set(['user-1']);
    const { as, route } = build(members);
    const { client } = await as.registerClient({ name: 'c', redirectUris: [REDIRECT] });
    const digest = new Bun.CryptoHasher('sha256').update('w'.repeat(64)).digest('base64url');
    const url = new URL(`${ISSUER}/oauth/consent`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      code_challenge: digest,
      code_challenge_method: 'S256',
      scope: 'tools:call',
    }).toString();
    const read = await as.readRequest(url);
    if (!read.ok) return expect.unreachable('consent refused');
    const back = new URL(await as.approve({ subject: 'user-1', request: read.request }));
    const tokens = await send(
      as,
      '/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        code_verifier: 'w'.repeat(64),
        redirect_uri: REDIRECT,
        client_id: client.clientId,
      }).toString(),
      'application/x-www-form-urlencoded',
    );
    expect((await call(route, String(tokens['access_token']))).status).toBe(200);
    members.delete('user-1');
    expect((await call(route, String(tokens['access_token']))).status).toBe(401);
  });
});
