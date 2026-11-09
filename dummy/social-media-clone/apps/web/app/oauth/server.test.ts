// An MCP client connecting to the demo, end to end on the real wiring: `/mcp`'s 401 names the
// protected-resource document, a person consents, the code is exchanged at the mounted token
// route, and the token is an agent acting for that person — refused once they may no longer act.

import { beforeAll, describe, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import type { McpRequestFacts } from '@ultimat3/mcp';
import { mcp, resolveMcpToken } from '../../mcp';
import { runtime } from '../../runtime';
import {
  appOrigin,
  hostOf,
  isMetadataClient,
  MCP_SCOPE,
  mayRedirectRefusal,
  mcpOAuth,
  oauthActor,
} from './server';

const REDIRECT = 'http://127.0.0.1:33418/callback';
const FACTS: McpRequestFacts = {
  origin: null,
  address: '127.0.0.1',
  userAgent: null,
  path: '/mcp',
};

beforeAll(async () => {
  await seedDemo();
});

const post = async (path: string, form: Record<string, string>) => {
  const route = runtime.routes.find((one) => one.method === 'POST' && one.path === path);
  if (route === undefined) return expect.unreachable(`runtime.ts mounts no POST ${path}`);
  const raw = new Request(`${appOrigin()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const bytes = new Uint8Array(await raw.clone().arrayBuffer());
  const response = await route.handler({ raw, bodyBytes: async () => bytes }, { ip: '127.0.0.1' });
  return (await response.json()) as Record<string, unknown>;
};

/** Register, consent as `subject`, exchange: the access token a desktop client ends up holding. */
async function connect(subject: string): Promise<string> {
  const { client } = await mcpOAuth.registerClient({ name: 'Desktop', redirectUris: [REDIRECT] });
  const verifier = 'v'.repeat(64);
  const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${appOrigin()}/oauth/consent`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: MCP_SCOPE,
    state: 's',
  }).toString();
  const read = await mcpOAuth.readRequest(authorize);
  if (!read.ok) return expect.unreachable(`consent refused: ${read.description}`);
  const back = new URL(await mcpOAuth.approve({ subject, request: read.request }));
  const tokens = await post('/oauth/token', {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code') ?? '',
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.clientId,
  });
  return String(tokens['access_token']);
}

describe('MCP OAuth', () => {
  test('unit · the 401 names the protected-resource document, which names this server', async () => {
    const route = mcp.route;
    if (route === undefined) return expect.unreachable('apps/web/mcp.ts built no route');
    const refused = await route.handle(
      new Request(`${appOrigin()}/mcp`, { method: 'POST', body: '{}' }),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate') ?? '').toContain(
      `resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(route.protectedResource?.document(appOrigin())['authorization_servers']).toEqual([
      appOrigin(),
    ]);
  });

  test('unit · a consented token is an agent acting for the person, with their role', async () => {
    const userId = seedId('user:user');
    const caller = await resolveMcpToken(await connect(userId), FACTS);
    expect(caller?.actor.kind).toBe('agent');
    // Per grant: two people on one client are two agents, never one rate-limit and audit identity.
    expect(caller?.actor.id).toMatch(new RegExp(`^oauth:[^:]+:${userId}$`));
    expect(caller?.actor.roles).toEqual(['member']);
    expect(caller?.actor.onBehalfOf).toEqual({ actorKind: 'user', actorId: userId });
  });

  test('unit · a token for someone who may not act, or no token at all, opens nothing', async () => {
    expect(
      await oauthActor({
        subject: 'nobody',
        clientId: 'c',
        scopes: new Set([MCP_SCOPE]),
        resource: null,
      }),
    ).toBeNull();
    expect(await resolveMcpToken('not-a-token', FACTS)).toBeNull();
  });

  test('unit · only a metadata-document client is redirected to on a refusal', () => {
    const doc = 'https://client.example/oauth/client.json';
    expect(isMetadataClient(doc)).toBe(true);
    expect(isMetadataClient('c_abc')).toBe(false);
    expect(isMetadataClient(null)).toBe(false);
    expect(mayRedirectRefusal(new URLSearchParams({ client_id: doc }))).toBe(true);
    expect(mayRedirectRefusal(new URLSearchParams({ client_id: 'c_abc' }))).toBe(false);
    expect(mayRedirectRefusal(new URLSearchParams())).toBe(false);
  });

  test('unit · the host the consent page shows is the URL host, port included', () => {
    expect(hostOf('http://127.0.0.1:33418/callback')).toBe('127.0.0.1:33418');
    expect(hostOf('https://client.example/c.json')).toBe('client.example');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
