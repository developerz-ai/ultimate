// Single responsibility: turning an OIDC issuer URL into an `OAuthProvider`, by reading the
// discovery document every conforming OP publishes (OIDC Discovery 1.0, §4). One `fetch`, at
// boot, no dependency — an enterprise IdP is then three lines instead of a hand-copied table of
// four endpoints that nobody re-checks when the vendor moves one.

import { renderThrowable } from '@ultimat3/core';
import { isRecord } from './json';
import type { OAuthProvider } from './oauth';
import { oauthExchangeFailed } from './oauth-errors';
import type { OAuthFetch } from './oauth-exchange';

const DEFAULT_TIMEOUT_MS = 10_000;

/** The document lives at a fixed suffix off the issuer; the issuer keeps its own path. */
export const discoveryUrl = (issuer: string): string =>
  `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

export interface DiscoverOAuthProviderInput {
  /** The id the URL segment carries: `/auth/oauth/<id>`. Also names the two env vars. */
  readonly id: string;
  readonly issuer: string;
  /** Defaults to the OIDC minimum this package needs to identify somebody. */
  readonly scopes?: readonly string[] | undefined;
  readonly clientIdEnv?: string | undefined;
  readonly clientSecretEnv?: string | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const stringOrNull = (body: Record<string, unknown>, key: string): string | null => {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** `bigco-sso` → `BIGCO_SSO_CLIENT_ID`, the same shape the three built-ins use. */
const envPrefix = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Reads the issuer's discovery document and returns the provider. It does **not** register:
 * `registerOAuthProvider(await discoverOAuthProvider({ id, issuer }))` keeps one install point,
 * and an app that wants to override one endpoint spreads the result before registering it.
 *
 * `issuers` is pinned to the `issuer` the document itself declares, not the URL that was asked
 * for — a document that names a different issuer is answering for somebody else, and pinning the
 * requested URL would let it.
 */
export async function discoverOAuthProvider(
  input: DiscoverOAuthProviderInput,
): Promise<OAuthProvider> {
  const url = discoveryUrl(input.issuer);
  const doFetch: OAuthFetch = input.fetch ?? ((target, init) => globalThis.fetch(target, init));

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw oauthExchangeFailed({
      provider: input.id,
      stage: 'discovery',
      // `renderThrowable`: an injected `fetch` may reject with anything, `instanceof` throws on a
      // value that traps `getPrototypeOf`, and a bare `TypeError` here is an uncoded crash.
      detail: renderThrowable(error),
      fix: `curl -sS -m 5 ${url}`,
    });
  }

  if (!response.ok) {
    throw oauthExchangeFailed({
      provider: input.id,
      stage: 'discovery',
      detail: 'the issuer published no discovery document at the well-known path',
      status: response.status,
      fix: `curl -sS -m 5 ${url}   # then pass the real issuer URL to discoverOAuthProvider({ issuer })`,
    });
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body)) {
    throw oauthExchangeFailed({
      provider: input.id,
      stage: 'discovery',
      detail: 'the discovery document is not a JSON object',
      fix: `confirm ${url} is the OP's own discovery document and not a login page`,
    });
  }

  const issuer = stringOrNull(body, 'issuer');
  const authorizeUrl = stringOrNull(body, 'authorization_endpoint');
  const tokenUrl = stringOrNull(body, 'token_endpoint');
  if (issuer === null || authorizeUrl === null || tokenUrl === null) {
    throw oauthExchangeFailed({
      provider: input.id,
      stage: 'discovery',
      detail:
        'the discovery document is missing issuer, authorization_endpoint or token_endpoint, ' +
        'so no handshake can be built from it',
      fix: `curl -sS -m 5 ${url} | jq '{issuer, authorization_endpoint, token_endpoint}'`,
    });
  }

  const jwksUri = stringOrNull(body, 'jwks_uri');
  if (jwksUri === null) {
    // Without a key set there is nothing to verify an id token against, and the only remaining
    // trust is the TLS channel to the token endpoint — which is the exemption, not a default.
    throw oauthExchangeFailed({
      provider: input.id,
      stage: 'discovery',
      detail:
        'the discovery document publishes no jwks_uri, so no id token from it can be verified',
      fix: `register this provider by hand with an explicit jwksUri: registerOAuthProvider({ id: '${input.id}', ... })`,
    });
  }

  const prefix = envPrefix(input.id);
  return {
    id: input.id,
    authorizeUrl,
    tokenUrl,
    userInfoUrl: stringOrNull(body, 'userinfo_endpoint'),
    userEmailsUrl: null,
    issuers: [issuer],
    jwksUri,
    scopes: input.scopes ?? ['openid', 'email', 'profile'],
    usesPkce: true,
    usesNonce: true,
    clientIdEnv: input.clientIdEnv ?? `${prefix}_CLIENT_ID`,
    clientSecretEnv: input.clientSecretEnv ?? `${prefix}_CLIENT_SECRET`,
  };
}
