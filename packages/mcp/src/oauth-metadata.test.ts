// OAuth discovery on the MCP route (MCP authorization spec 2025-06-18 / 2025-11-25, RFC 9728):
// the 401 names the metadata, the metadata names the authorization server, and nothing about an
// app that declares no `oauth` changes.

import { describe, expect, test } from 'bun:test';
import { defineAppMcp } from './app-tools';
import {
  bearerChallenge,
  metadataPaths,
  metadataUrlFor,
  protectedResourceMetadata,
} from './oauth-metadata';
import { mcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const server = mcpServer({ tools: [], resources: [], prompts: [] });
const OAUTH = { authorizationServers: ['https://www.example.com'], resourceName: 'Example' };

const post = (headers: Record<string, string> = {}): Request =>
  new Request('http://internal:3000/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });

describe('the 401 challenge', () => {
  test('names the path-inserted metadata URL on the PUBLIC origin the host saw', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null, oauth: OAUTH });
    const res = await route.handle(post(), { origin: 'https://www.example.com' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="ultimate-mcp", resource_metadata="https://www.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('a token that did not resolve adds error="invalid_token"', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null, oauth: OAUTH });
    const res = await route.handle(post({ authorization: 'Bearer stale' }), {
      origin: 'https://www.example.com',
    });
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  test('a declared resource wins over the request origin', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => null,
      oauth: { ...OAUTH, resource: 'https://api.example.com/mcp' },
    });
    const res = await route.handle(post());
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  // MCP authorization spec 2025-06-18 / 2025-11-25 and RFC 6750 §3: the challenge names the scopes
  // the resource supports, so a client asks the authorization server for them without first
  // fetching the metadata document.
  test('carries scope="…" — the supported scopes, sorted and space-separated', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => null,
      oauth: OAUTH,
      scopes: ['cases:write', 'cases:read'],
    });
    const res = await route.handle(post(), { origin: 'https://www.example.com' });
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="ultimate-mcp", resource_metadata="https://www.example.com/.well-known/oauth-protected-resource/mcp", scope="cases:read cases:write"',
    );
    const stale = await route.handle(post({ authorization: 'Bearer stale' }), {
      origin: 'https://www.example.com',
    });
    expect(stale.headers.get('www-authenticate')).toBe(
      'Bearer realm="ultimate-mcp", error="invalid_token", resource_metadata="https://www.example.com/.well-known/oauth-protected-resource/mcp", scope="cases:read cases:write"',
    );
  });

  test('a stated scopesSupported is the scope the challenge names, as the document does', async () => {
    const route = mcpHttpRoute({
      server,
      resolveToken: () => null,
      oauth: { ...OAUTH, scopesSupported: ['mcp'] },
      scopes: ['cases:read'],
    });
    const res = await route.handle(post(), { origin: 'https://www.example.com' });
    expect(res.headers.get('www-authenticate')).toEndWith(', scope="mcp"');
  });

  test('no scopes, no scope parameter', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null, oauth: OAUTH });
    const res = await route.handle(post(), { origin: 'https://www.example.com' });
    expect(res.headers.get('www-authenticate')).not.toContain('scope=');
  });

  // RFC 6749 §5.1 / RFC 6750 §3: an authentication answer is never stored, least of all by a
  // shared cache that would hand one caller's challenge to the next.
  test('every 401 is cache-control: no-store', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null, oauth: OAUTH });
    const anonymous = await route.handle(post(), { origin: 'https://www.example.com' });
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    const stale = await route.handle(post({ authorization: 'Bearer stale' }));
    expect(stale.headers.get('cache-control')).toBe('no-store');
  });

  test('without oauth the challenge is the one it always was', async () => {
    const route = mcpHttpRoute({ server, resolveToken: () => null });
    const res = await route.handle(post());
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ultimate-mcp"');
    expect(route.protectedResource).toBeUndefined();
  });
});

describe('the metadata document', () => {
  test('defineAppMcp publishes it with the scopes map as scopes_supported', () => {
    const app = defineAppMcp({
      resolveToken: () => null,
      oauth: OAUTH,
      tools: {},
    });
    const resource = app.route?.protectedResource;
    expect(resource?.paths).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
    expect(resource?.document('https://www.example.com')).toEqual({
      resource: 'https://www.example.com/mcp',
      authorization_servers: ['https://www.example.com'],
      bearer_methods_supported: ['header'],
      resource_name: 'Example',
    });
  });

  test('scopes_supported is stated or derived, sorted', () => {
    expect(
      protectedResourceMetadata(OAUTH, 'https://x.test/mcp', ['cases:write', 'cases:read'])[
        'scopes_supported'
      ],
    ).toEqual(['cases:read', 'cases:write']);
  });

  test('RFC 9728 path insertion', () => {
    expect(metadataUrlFor('https://x.test/mcp')).toBe(
      'https://x.test/.well-known/oauth-protected-resource/mcp',
    );
    expect(metadataUrlFor('https://x.test')).toBe(
      'https://x.test/.well-known/oauth-protected-resource',
    );
    expect(metadataPaths('/')).toEqual(['/.well-known/oauth-protected-resource']);
  });

  test('bearerChallenge without metadata is the realm alone', () => {
    expect(bearerChallenge(undefined, false)).toBe('Bearer realm="ultimate-mcp"');
  });
});

describe('the oauth block is refused at definition', () => {
  test.each([
    [{ authorizationServers: [] }],
    [{ authorizationServers: ['http://auth.example.com'] }],
    [{ authorizationServers: ['auth.example.com'] }],
    [{ authorizationServers: ['https://x.test'], resource: 'https://x.test/mcp#frag' }],
  ])('%j', (oauth) => {
    expect(() => mcpHttpRoute({ server, resolveToken: () => null, oauth })).toThrow(
      expect.objectContaining({ code: 'X_MCP_OAUTH_INVALID' }),
    );
  });

  // A scope-token is `%x21 / %x23-5B / %x5D-7E` (RFC 6749 §3.3): a space splits it in the
  // challenge's list and a quote or backslash ends the quoted-string early.
  test.each([['two words'], ['say"hi'], ['back\\slash'], ['']])(
    'a scope %j that cannot travel in a challenge is refused',
    (scope) => {
      expect(() =>
        mcpHttpRoute({ server, resolveToken: () => null, oauth: OAUTH, scopes: [scope] }),
      ).toThrow(expect.objectContaining({ code: 'X_MCP_OAUTH_INVALID' }));
      expect(() =>
        mcpHttpRoute({
          server,
          resolveToken: () => null,
          oauth: { ...OAUTH, scopesSupported: [scope] },
        }),
      ).toThrow(expect.objectContaining({ code: 'X_MCP_OAUTH_INVALID' }));
    },
  );

  test('http is accepted on loopback, for bin/dev', () => {
    expect(() =>
      mcpHttpRoute({
        server,
        resolveToken: () => null,
        oauth: { authorizationServers: ['http://localhost:3000'] },
      }),
    ).not.toThrow();
  });
});
