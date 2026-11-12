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

function vendor(
  asOverrides: Record<string, unknown> = {},
  prmOverrides: Record<string, unknown> = {},
) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, body: init.body === undefined ? '' : String(init.body) });
    if (url === 'https://mcp.vendor.test/.well-known/oauth-protected-resource/mcp') {
      return Response.json({
        resource: MCP,
        authorization_servers: [ISSUER],
        scopes_supported: ['docs:read'],
        ...prmOverrides,
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

  /** Metadata a remote server controls is input: a value that is no URL is a coded refusal. */
  const refusedCode = { code: 'X_MCP_REMOTE_REFUSED' };

  test('an authorization server that is no URL is refused, never a bare TypeError', async () => {
    await expect(
      vendor({}, { authorization_servers: ['not a url'] }).oauth.begin(MCP),
    ).rejects.toMatchObject(refusedCode);
  });

  for (const field of ['authorization_endpoint', 'token_endpoint']) {
    test(`a ${field} that is no URL is refused`, async () => {
      await expect(vendor({ [field]: 'not a url' }).oauth.begin(MCP)).rejects.toMatchObject(
        refusedCode,
      );
    });
  }

  for (const [field, value] of [
    ['authorization_endpoint', 'javascript:alert(document.domain)//'],
    ['authorization_endpoint', 'data:text/html,<script>alert(1)</script>'],
    ['authorization_endpoint', 'http://auth.vendor.test/authorize'],
    ['token_endpoint', 'file:///etc/passwd'],
  ] as const) {
    test(`a ${field} that is not https: (${value.slice(0, 11)}) is refused`, async () => {
      // An authorizeUrl is rendered as a link: a `javascript:` one runs in the app's origin.
      await expect(vendor({ [field]: value }).oauth.begin(MCP)).rejects.toMatchObject(refusedCode);
    });
  }

  test('a loopback http: authorization server still works, as RFC 8252 allows', async () => {
    const start = await vendor({
      authorization_endpoint: 'http://127.0.0.1:9999/authorize',
    }).oauth.begin(MCP);
    expect(start.authorizeUrl).toStartWith('http://127.0.0.1:9999/authorize?');
  });

  test('a server URL that is no URL is refused before anything is fetched', async () => {
    const { oauth, sent } = vendor();
    await expect(oauth.begin('mcp.vendor.test/mcp')).rejects.toMatchObject(refusedCode);
    expect(sent).toHaveLength(0);
  });

  test('resource metadata naming ANOTHER resource is refused (RFC 9728 §3.3)', async () => {
    await expect(
      vendor({}, { resource: 'https://evil.test/mcp' }).oauth.begin(MCP),
    ).rejects.toMatchObject(refusedCode);
    await expect(vendor({}, { resource: 42 }).oauth.begin(MCP)).rejects.toMatchObject(refusedCode);
  });

  test('the comparison is on the URL, not its spelling', async () => {
    const start = await vendor({}, { resource: 'HTTPS://MCP.vendor.test:443/mcp' }).oauth.begin(
      MCP,
    );
    expect(new URL(start.authorizeUrl).searchParams.get('resource')).toBe(MCP);
  });
});
