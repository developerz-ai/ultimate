// Single responsibility: screen an authorization request (RFC 6749 §4.1.1 + PKCE + RFC 8707) into
// what a consent page may show, or the refusal it must show instead. Pure over the client it is
// handed. An unknown client or an unregistered redirect is SHOWN and never redirected to
// (RFC 6749 §4.1.2.1); every later refusal goes back to the registered redirect with `iss`.

import type { ResolvedAuthServerConfig } from './authorization-server-config';
import type { AuthorizationRequest, AuthServerClient } from './authorization-server-types';

export type ReadRequestResult =
  | { readonly ok: true; readonly request: AuthorizationRequest }
  | {
      readonly ok: false;
      readonly error: string;
      readonly description: string;
      /** Where the browser goes with the error; `null` = render it, redirect nowhere. */
      readonly redirectTo: string | null;
    };

/** RFC 7636 §4.2: 43–128 characters of the unreserved set, base64url of a SHA-256 in practice. */
const CODE_CHALLENGE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** `redirectUri` plus the params, an existing query kept (RFC 6749 §3.1.2). */
export function redirectWith(
  redirectUri: string,
  params: Readonly<Record<string, string>>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** One value per parameter, or the refusal: RFC 6749 §3.1 forbids a repeated one. */
export function singleParams(params: URLSearchParams): Map<string, string> | string {
  const single = new Map<string, string>();
  for (const [key, value] of params) {
    if (single.has(key)) return key;
    single.set(key, value);
  }
  return single;
}

/** The requested scopes narrowed to what the server and the client allow, or `null` = refused. */
export function screenScopes(
  config: ResolvedAuthServerConfig,
  client: AuthServerClient,
  requested: string | undefined,
): readonly string[] | null {
  const allowed = (scope: string): boolean =>
    config.scopes.has(scope) && (client.scopes.length === 0 || client.scopes.includes(scope));
  if (requested === undefined || requested.trim() === '') {
    const fallback = client.scopes.length > 0 ? client.scopes : [...config.scopes];
    return fallback.filter(allowed);
  }
  const asked = [...new Set(requested.split(' ').filter((scope) => scope !== ''))];
  return asked.every(allowed) ? asked : null;
}

/** RFC 8707: none (the default resource, else an unbound grant), or one this server declared. */
export function screenResource(
  config: ResolvedAuthServerConfig,
  resource: string | undefined,
): string | null | false {
  if (resource === undefined) return config.defaultResource;
  return config.resources.has(resource) ? resource : false;
}

export function screenAuthorization(
  config: ResolvedAuthServerConfig,
  client: AuthServerClient | null,
  params: URLSearchParams,
): ReadRequestResult {
  const single = singleParams(params);
  const shown = (error: string, description: string): ReadRequestResult => ({
    ok: false,
    error,
    description,
    redirectTo: null,
  });
  if (typeof single === 'string') {
    return shown('invalid_request', `the ${single} parameter is repeated`);
  }
  if (client === null) return shown('invalid_client', 'the client is not known to this server');
  const redirectUri = single.get('redirect_uri');
  // Byte for byte: no normalisation, no prefix, no trailing-slash leniency. Not a secret, so `===`.
  if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
    return shown('invalid_request', 'the redirect_uri is not one this client registered');
  }
  const state = single.get('state') ?? null;
  const back = (error: string, description: string): ReadRequestResult => ({
    ok: false,
    error,
    description,
    redirectTo: redirectWith(redirectUri, {
      error,
      error_description: description,
      iss: config.issuer,
      ...(state === null ? {} : { state }),
    }),
  });
  if (single.get('response_type') !== 'code') {
    return back('unsupported_response_type', 'only response_type=code is supported');
  }
  if (!client.grantTypes.includes('authorization_code')) {
    return back('unauthorized_client', 'this client may not use the authorization code grant');
  }
  const challenge = single.get('code_challenge');
  if (challenge === undefined || !CODE_CHALLENGE.test(challenge)) {
    return back('invalid_request', 'a PKCE code_challenge is required');
  }
  // S256 only, and an absent method is `plain` per RFC 7636 §4.3 — refused, not defaulted.
  if (single.get('code_challenge_method') !== 'S256') {
    return back('invalid_request', 'code_challenge_method must be S256');
  }
  const scopes = screenScopes(config, client, single.get('scope'));
  if (scopes === null || scopes.length === 0) {
    return back('invalid_scope', 'a requested scope is not one this client may be granted');
  }
  const resource = screenResource(config, single.get('resource'));
  if (resource === false) {
    return back('invalid_target', 'the resource is not one this server issues tokens for');
  }
  return {
    ok: true,
    request: { client, redirectUri, scopes, resource, state, codeChallenge: challenge },
  };
}
