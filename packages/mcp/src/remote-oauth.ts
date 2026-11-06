/**
 * `mcpOAuthClient()` — this app authorising to ANOTHER server's MCP endpoint per the MCP auth spec:
 * RFC 9728 then RFC 8414 discovery, a client ID metadata document as `client_id`, PKCE S256
 * (`@ultimat3/auth`'s `pkcePair`) and RFC 8707 `resource` in both legs.
 */

import { pkcePair, randomToken } from '@ultimat3/auth';
import { isJsonObject, timingSafeEqual } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import { outboundResponse } from '@ultimat3/core/outbound';
import { McpRemoteRefusedError } from './remote-errors';

export interface McpOAuthClientOptions {
  /**
   * The client's id: the HTTPS URL its metadata document is served at (serve `metadata()` there),
   * or an id the authorization server issued when this app was registered by hand.
   */
  readonly clientId: string;
  /** Shown to the person on the consent screen. */
  readonly clientName: string;
  /** This app's callback; listed in the metadata document. */
  readonly redirectUri: string;
  /** Asked for when given; else what the server's metadata lists as supported, if anything. */
  readonly scopes?: readonly string[];
  readonly dial?: 'public' | 'named';
  readonly deadlineMs?: number;
  readonly fetch?: OutboundFetch;
}

/** Everything the callback needs — keep it server-side (a sealed cookie, a row), never in a URL. */
export interface McpOAuthHandshake {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  /** The MCP server's URL: RFC 8707's `resource`, sent in both legs. */
  readonly resource: string;
  readonly tokenEndpoint: string;
}

export interface McpOAuthStart {
  /** Where to send the person. */
  readonly authorizeUrl: string;
  readonly handshake: McpOAuthHandshake;
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Seconds, as the server said; the app stamps its own clock on it. */
  readonly expiresIn: number | null;
}

export interface McpOAuthClient {
  /** The client ID metadata document — serve it, as JSON, at `clientId`. */
  metadata(): Readonly<Record<string, unknown>>;
  begin(serverUrl: string): Promise<McpOAuthStart>;
  exchange(
    handshake: McpOAuthHandshake,
    callback: { readonly code: string; readonly state: string },
  ): Promise<McpOAuthTokens>;
  refresh(
    handshake: Pick<McpOAuthHandshake, 'resource' | 'tokenEndpoint'>,
    refreshToken: string,
  ): Promise<McpOAuthTokens>;
}

const DEFAULT_DEADLINE_MS = 10_000;

export function mcpOAuthClient(options: McpOAuthClientOptions): McpOAuthClient {
  const refused = (url: string, reason: string, status?: number) =>
    new McpRemoteRefusedError({
      server: 'oauth',
      url,
      reason,
      failure: status === undefined ? 'malformed' : 'status',
      ...(status === undefined ? {} : { status }),
    });

  /** One metadata read: the JSON object, or `undefined` for a 404 (the next candidate is tried). */
  const send = (url: string, init: { method?: 'POST'; body?: URLSearchParams }) =>
    outboundResponse(
      {
        url,
        vendor: 'mcp:oauth',
        dial: options.dial ?? 'public',
        deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        headers: { accept: 'application/json' },
        ...init,
      },
      options.fetch === undefined ? {} : { fetch: options.fetch },
    );

  /** One metadata read: the JSON object, or `undefined` for a 404 (the next candidate is tried). */
  const getJson = async (url: string): Promise<Record<string, unknown> | undefined> => {
    const answer = await send(url, {});
    if (answer.status === 404) return undefined;
    if (!answer.ok)
      throw refused(url, `answered its metadata with HTTP ${answer.status}`, answer.status);
    const body = parseObject(await answer.text());
    if (body === undefined) throw refused(url, 'answered its metadata with no JSON object');
    return body;
  };

  const firstOf = async (url: string, candidates: readonly string[]) => {
    for (const candidate of candidates) {
      const found = await getJson(candidate);
      if (found !== undefined) return found;
    }
    throw refused(url, `published no metadata at ${candidates.join(' or ')}`);
  };

  const token = async (endpoint: string, form: URLSearchParams): Promise<McpOAuthTokens> => {
    const answer = await send(endpoint, { method: 'POST', body: form });
    if (!answer.ok) {
      // The body is not quoted: a token endpoint echoing its request would echo the code.
      throw refused(
        endpoint,
        `refused the token request with HTTP ${answer.status}`,
        answer.status,
      );
    }
    const body = parseObject(await answer.text());
    const access = body?.['access_token'];
    if (body === undefined || typeof access !== 'string' || access === '') {
      throw refused(endpoint, 'answered the token request with no access_token');
    }
    const refresh = body['refresh_token'];
    const expires = body['expires_in'];
    return {
      accessToken: access,
      refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
      expiresIn: typeof expires === 'number' && Number.isFinite(expires) ? expires : null,
    };
  };

  return {
    metadata: () => ({
      client_id: options.clientId,
      client_name: options.clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),

    async begin(serverUrl) {
      const resource = new URL(serverUrl);
      resource.hash = '';
      const prm = await firstOf(serverUrl, wellKnown(resource, 'oauth-protected-resource'));
      const issuer = Array.isArray(prm['authorization_servers'])
        ? prm['authorization_servers'].find((entry) => typeof entry === 'string')
        : undefined;
      if (typeof issuer !== 'string') {
        throw refused(serverUrl, 'names no authorization server in its resource metadata');
      }
      const as = await firstOf(issuer, authServerCandidates(new URL(issuer)));
      // RFC 8414 §3.3: a document answering for another issuer is not this issuer's.
      if (as['issuer'] !== issuer) throw refused(issuer, 'published metadata for another issuer');
      const authorize = as['authorization_endpoint'];
      const tokenEndpoint = as['token_endpoint'];
      if (typeof authorize !== 'string' || typeof tokenEndpoint !== 'string') {
        throw refused(issuer, 'names no authorization_endpoint or token_endpoint');
      }
      const methods = as['code_challenge_methods_supported'];
      if (!Array.isArray(methods) || !methods.includes('S256')) {
        throw refused(issuer, 'does not offer PKCE S256, which an MCP client must use');
      }
      if (
        options.clientId.startsWith('https://') &&
        as['client_id_metadata_document_supported'] !== true
      ) {
        throw refused(issuer, 'does not accept a client ID metadata document');
      }
      const pkce = pkcePair();
      const state = randomToken(16);
      const url = new URL(authorize);
      const scopes = options.scopes ?? stringList(prm['scopes_supported']);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', pkce.method);
      url.searchParams.set('resource', resource.toString());
      if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
      return {
        authorizeUrl: url.toString(),
        handshake: {
          state,
          verifier: pkce.verifier,
          redirectUri: options.redirectUri,
          resource: resource.toString(),
          tokenEndpoint,
        },
      };
    },

    exchange(handshake, callback) {
      // The one gate between a redirect and a token: a forged callback carries another state.
      if (!timingSafeEqual(handshake.state, callback.state)) {
        return Promise.reject(refused(handshake.tokenEndpoint, 'came back with another state'));
      }
      return token(
        handshake.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.code,
          redirect_uri: handshake.redirectUri,
          client_id: options.clientId,
          code_verifier: handshake.verifier,
          resource: handshake.resource,
        }),
      );
    },

    refresh: (handshake, refreshToken) =>
      token(
        handshake.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: options.clientId,
          resource: handshake.resource,
        }),
      ),
  };
}

/** RFC 9728 §3.1: the suffix goes between host and path, then the root as a fallback. */
function wellKnown(url: URL, suffix: string): readonly string[] {
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const root = `${url.origin}/.well-known/${suffix}`;
  return path === '' ? [root] : [`${root}${path}`, root];
}

/** RFC 8414 first, then OIDC discovery in both placements the MCP spec lists. */
function authServerCandidates(issuer: URL): readonly string[] {
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/+$/, '');
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    ...(path === '' ? [] : [`${issuer.origin}${path}/.well-known/openid-configuration`]),
  ];
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    // Not JSON is "no document": the caller names the refusal.
    return undefined;
  }
}
