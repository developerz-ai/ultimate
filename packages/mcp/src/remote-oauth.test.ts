// `mcpOAuthClient()` against a fake MCP server + authorization server: discovery follows RFC 9728
// then RFC 8414, the authorize URL carries PKCE S256, `resource` and the client ID metadata
// document's URL, the exchange sends the verifier and `resource`, and a wrong state never reaches
// the token endpoint. An issuer that offers no S256 is refused.

import { describe, expect, test } from 'bun:test';
import { mcpOAuthClient } from './remote-oauth';

/** RFC 7636 S256, computed here independently of the code under test. */
const s256 = (verifier: string): string =>
  new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');

const MCP = 'https://mcp.vendor.test/mcp';
const ISSUER = 'https://auth.vendor.test';
const CLIENT_ID = 'https://app.test/oauth/mcp-client.json';

interface Sent {
  readonly url: string;
  readonly body: string;
}

function vendor(asOverrides: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, body: init.body === undefined ? '' : String(init.body) });
    if (url === 'https://mcp.vendor.test/.well-known/oauth-protected-resource/mcp') {
      return Response.json({
        resource: MCP,
        authorization_servers: [ISSUER],
        scopes_supported: ['docs:read'],
      });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        ...asOverrides,
      });
    }
    if (url === `${ISSUER}/token`) {
      return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    }
    return new Response('not here', { status: 404 });
  };
  const oauth = mcpOAuthClient({
    clientId: CLIENT_ID,
    clientName: 'Demo',
    redirectUri: 'https://app.test/oauth/mcp/callback',
    dial: 'named',
    fetch,
  });
  return { oauth, sent };
}

describe('mcpOAuthClient', () => {
  test('discovery, then an authorize URL bound by PKCE S256 and resource', async () => {
    const { oauth } = vendor();
    const { authorizeUrl, handshake } = await oauth.begin(MCP);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('resource')).toBe(MCP);
    expect(url.searchParams.get('scope')).toBe('docs:read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(s256(handshake.verifier));
    expect(url.searchParams.get('state')).toBe(handshake.state);
    expect(handshake.tokenEndpoint).toBe(`${ISSUER}/token`);
  });

  test('the exchange sends the verifier and resource, and answers the tokens', async () => {
    const { oauth, sent } = vendor();
    const { handshake } = await oauth.begin(MCP);
    const tokens = await oauth.exchange(handshake, { code: 'c-1', state: handshake.state });
    expect(tokens).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 });
    const form = new URLSearchParams(sent.at(-1)?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe(handshake.verifier);
    expect(form.get('resource')).toBe(MCP);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    const refreshed = await oauth.refresh(handshake, 'rt-1');
    expect(refreshed.accessToken).toBe('at-1');
    expect(new URLSearchParams(sent.at(-1)?.body).get('grant_type')).toBe('refresh_token');
  });

  test('a callback with another state never reaches the token endpoint', async () => {
    const { oauth, sent } = vendor();
    const { handshake } = await oauth.begin(MCP);
    const before = sent.length;
    await expect(oauth.exchange(handshake, { code: 'c', state: 'forged' })).rejects.toMatchObject({
      code: 'X_MCP_REMOTE_REFUSED',
    });
    expect(sent.length).toBe(before);
  });

  test('an issuer without S256, or without metadata documents, is refused', async () => {
    await expect(
      vendor({ code_challenge_methods_supported: ['plain'] }).oauth.begin(MCP),
    ).rejects.toMatchObject({ code: 'X_MCP_REMOTE_REFUSED' });
    await expect(
      vendor({ client_id_metadata_document_supported: false }).oauth.begin(MCP),
    ).rejects.toMatchObject({ code: 'X_MCP_REMOTE_REFUSED' });
  });

  test('the metadata document names the client, its redirect and no secret', () => {
    expect(vendor().oauth.metadata()).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uris: ['https://app.test/oauth/mcp/callback'],
      token_endpoint_auth_method: 'none',
    });
  });
});
