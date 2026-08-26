// Single responsibility: the authorization-code leg — the client credentials it needs and the
// one POST to the provider's token endpoint. `fetch` is the whole client; no SDK, no provider
// branch beyond the data in `oauth.ts`. The tokens this returns are already trustworthy: an id
// token is verified here, so no caller downstream can forget to.

import type { Clock } from '@ultimat3/core';
import {
  EnvMissingError,
  logger,
  renderCauseValue,
  renderThrowable,
  systemClock,
} from '@ultimat3/core';
import { type IdTokenClaims, verifyIdToken } from './id-token';
import { isRecord } from './json';
import type { IdTokenKeys } from './jwks';
import {
  assertOAuthCallback,
  type OAuthCallback,
  type OAuthHandshake,
  type OAuthProviderId,
} from './oauth';
import { oauthExchangeFailed, restartAt } from './oauth-errors';
import { providerFor } from './oauth-registry';
import { assertFiniteAuthCount } from './policy-numbers';

/** Just the call. `typeof fetch` also carries `preconnect`, which no test double should have to. */
export type OAuthFetch = (input: string, init: RequestInit) => Promise<Response>;

/** GitHub answers 403 to a request with no user agent, so every call this package makes has one. */
export const OAUTH_USER_AGENT = 'ultimate-auth';

/** Named in the refusal above the one `fetch` this file makes. */
const TIMEOUT_CONSEQUENCE =
  'AbortSignal.timeout throws a bare TypeError on it, several frames below the option that set it, so the leg fails with an error that names neither this package nor the option';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DETAIL_LENGTH = 200;

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly idToken: string | null;
  /** Verified claims of `idToken`. `null` when the provider issues no id token. */
  readonly claims: IdTokenClaims | null;
}

export interface OAuthExchangeOptions {
  readonly credentials: OAuthClientCredentials;
  /** No `Date.now()` in this package: the token expiry is measured against this. */
  readonly clock?: Clock | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Defaults to `'token-endpoint-tls'`, and this is the one call site where that default is
   * correct: the id token below was read off a TLS response from the provider's own token
   * endpoint, which is the channel OIDC Core 3.1.3.7 exempts. An app that pins the key set anyway
   * — a corporate egress proxy, a compliance requirement — passes `providerJwks(providerFor(id))`.
   */
  readonly keys?: IdTokenKeys | undefined;
}

/**
 * Reads the two env vars the provider table names. Kept out of module scope on purpose —
 * importing `oauth.ts` still reads no env and touches no network.
 */
export function oauthCredentials(
  provider: OAuthProviderId,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): OAuthClientCredentials {
  const { clientIdEnv, clientSecretEnv } = providerFor(provider);
  const clientId = env[clientIdEnv]?.trim() ?? '';
  const clientSecret = env[clientSecretEnv]?.trim() ?? '';
  const missing = [
    ...(clientId === '' ? [clientIdEnv] : []),
    ...(clientSecret === '' ? [clientSecretEnv] : []),
  ];
  if (missing.length > 0) {
    throw new EnvMissingError({
      cause: `${provider} oauth is enabled but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
      fix: `add ${missing.join(' and ')} to .env from the ${provider} app's credentials, then run: x doctor --json`,
      meta: { provider, missing },
    });
  }
  return { clientId, clientSecret };
}

/**
 * Prefers the provider's own words; falls back to raw text, capped so a login page can't flood logs.
 *
 * Every branch but the empty-body sentence is a REMOTE server's bytes, and this string is spliced
 * into an `X_OAUTH_EXCHANGE_FAILED` cause — so a token endpoint that is compromised, impersonated
 * or merely behind a hostile proxy could otherwise write a second log line an operator reads as
 * genuine. Rendered here rather than at the factory because `OAuthExchangeFailure.detail` is
 * mostly prose this package authored, and quoting that would make every readable message unread-
 * able. The rule is "remote text is rendered", and this function is where remote text is made.
 */
/**
 * How much of a body this leg may quote back.
 *
 * `'raw'` — the default and what userinfo, discovery and jwks use: those requests carry a bearer
 * token or nothing, and the raw text is what makes a misconfigured enterprise OP debuggable.
 *
 * `'coded-only'` — the `POST /token` leg, and ONLY it. That request carries `client_secret`, and
 * an endpoint that echoes what it was sent (compromised, impersonated, or a misbehaving gateway)
 * put the secret into an `X_OAUTH_EXCHANGE_FAILED` `cause:` that `oauth-route.ts` publishes to an
 * unauthenticated caller. Measured: 38 of 42 characters of the secret reached the response body,
 * and a shorter `redirect_uri` fits all of it inside `MAX_DETAIL_LENGTH`. A coded OAuth error
 * still comes through — `invalid_grant`, `redirect_uri_mismatch` — because that is a field the
 * SPEC defines and the whole reason this string exists.
 */
export type DetailEcho = 'raw' | 'coded-only';

/** What a `coded-only` leg says instead of the body. Names why, so nobody re-adds the echo. */
const OPAQUE_BODY =
  'the endpoint answered with a body that is not a coded OAuth error, and this leg does not quote ' +
  'one back because its request carries the client secret';

export async function providerDetail(
  response: Response,
  echo: DetailEcho = 'raw',
): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text === '') return 'the response body was empty';
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const description = parsed['error_description'] ?? parsed['error'] ?? parsed['message'];
      if (typeof description === 'string' && description !== '') {
        return renderCauseValue(description);
      }
    }
  } catch {
    // Not JSON — fall through to the truncated raw text below.
  }
  if (echo === 'coded-only') return OPAQUE_BODY;
  return renderCauseValue(
    text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text,
  );
}

function fixForStatus(provider: OAuthProviderId, status: number): string {
  const { clientIdEnv, clientSecretEnv } = providerFor(provider);
  if (status === 401 || status === 403) {
    return `set ${clientIdEnv} and ${clientSecretEnv} to the current values in the ${provider} app settings`;
  }
  if (status === 400) {
    return `register this exact redirect_uri in the ${provider} app settings, then ${restartAt(provider)}`;
  }
  return `retry; if it persists, check the ${provider} status page before changing anything`;
}

async function postForm(
  provider: OAuthProviderId,
  body: URLSearchParams,
  options: OAuthExchangeOptions,
): Promise<Record<string, unknown>> {
  const doFetch: OAuthFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // Screened OUTSIDE the try below, deliberately: `AbortSignal.timeout(NaN)` throws, and the
  // catch around this fetch renders every throw as a provider failure — so a typo in the app's
  // own config read as the identity provider being unreachable.
  const timeoutMs = assertFiniteAuthCount(
    'oauth.exchange.timeoutMs',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    TIMEOUT_CONSEQUENCE,
    1,
  );
  const url = providerFor(provider).tokenUrl;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        // GitHub answers `application/x-www-form-urlencoded` unless asked for JSON.
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OAUTH_USER_AGENT,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The rendered value goes to the LOG, never into the `detail:`.
    //
    // `oauth-route.ts` publishes this cause to an unauthenticated caller, and the rejection comes
    // from an injected `OAuthFetch` — an app's own wrapper, a proxy client, an adapter behind it —
    // so its text is a server's internals. Reproduced: a bare
    // `Error('connect ECONNREFUSED 10.4.2.17:5432 (postgres://app:hunter2@db.internal/prod)')`
    // was served as the 502 body of a public callback. `problem()`'s uncoded branch does NOT catch
    // this one: it is coded by the time it gets there.
    //
    // `renderThrowable`, never `error.message` behind an `instanceof`: `instanceof` itself throws
    // on a value whose `getPrototypeOf` trap does, losing the one refusal that tells a caller the
    // code is already spent. What stays in the sentence is `url` and the remedy, both framework
    // constants, so the failure is still fixable without quoting anything this package does not own.
    logger.error('auth.oauth.token_fetch_failed', {
      provider,
      url,
      detail: renderThrowable(error),
    });
    throw oauthExchangeFailed({
      provider,
      stage: 'token',
      detail:
        `nothing left this host for ${url} (egress, DNS or TLS); the reason is in this process ` +
        'log under auth.oauth.token_fetch_failed. Restart the flow once it does, since the code ' +
        'is already spent',
      fix: `curl -sS -m 5 -o /dev/null ${url}`,
    });
  }

  if (!response.ok) {
    throw oauthExchangeFailed({
      provider,
      stage: 'token',
      // `coded-only`: this request carried `client_secret`, and `oauth-route.ts` publishes this
      // cause to whoever typed the URL.
      detail: await providerDetail(response, 'coded-only'),
      status: response.status,
      fix: fixForStatus(provider, response.status),
    });
  }

  const parsed: unknown = await response.json().catch(() => undefined);
  if (!isRecord(parsed)) {
    throw oauthExchangeFailed({
      provider,
      stage: 'token',
      detail: 'the token endpoint answered 200 with a body that is not a JSON object',
      fix: `confirm ${url} is the provider's real token endpoint and not a proxy`,
    });
  }

  // GitHub reports a bad code, a reused code and a wrong secret as HTTP 200 with an `error`
  // field. Trusting the status alone here mints a session from a failed exchange.
  const error = parsed['error'];
  if (typeof error === 'string' && error !== '') {
    const description = parsed['error_description'];
    throw oauthExchangeFailed({
      provider,
      stage: 'token',
      detail: typeof description === 'string' && description !== '' ? description : error,
      fix:
        error === 'bad_verification_code' || error === 'invalid_grant'
          ? `${restartAt(provider)} — an authorization code is single-use and short-lived`
          : fixForStatus(provider, 400),
    });
  }
  return parsed;
}

/**
 * Validates the callback, then trades the code for tokens. PKCE's verifier travels here and
 * nowhere else — it is what proves this exchange belongs to the browser that started the flow.
 */
export async function exchangeOAuthCode(
  handshake: OAuthHandshake,
  callback: OAuthCallback,
  options: OAuthExchangeOptions,
): Promise<OAuthTokens> {
  assertOAuthCallback(handshake, callback);
  const provider = providerFor(handshake.provider);
  const clock = options.clock ?? systemClock;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: handshake.redirectUri,
    client_id: options.credentials.clientId,
    client_secret: options.credentials.clientSecret,
  });
  // Unconditional: PKCE is not provider-dependent, and `OAuthProvider.usesPkce` is the type-level
  // statement of that — there is no configuration in which this line is skipped.
  body.set('code_verifier', handshake.verifier);

  const payload = await postForm(handshake.provider, body, options);
  const accessToken = payload['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw oauthExchangeFailed({
      provider: provider.id,
      stage: 'token',
      detail: 'the response carried no access_token',
      fix: `confirm the ${provider.id} app grants the scopes in providerFor('${provider.id}').scopes`,
    });
  }

  const refreshToken = payload['refresh_token'];
  const expiresIn = payload['expires_in'];
  const rawIdToken = payload['id_token'];
  const idToken = typeof rawIdToken === 'string' && rawIdToken !== '' ? rawIdToken : null;

  // An OIDC provider that answers without an id token has not identified anyone, and the
  // access token alone cannot be bound to this handshake's nonce.
  if (provider.usesNonce && idToken === null) {
    throw oauthExchangeFailed({
      provider: provider.id,
      stage: 'token',
      detail: 'the response carried no id_token',
      fix: `include "openid" in the scopes passed to beginOAuth() for ${provider.id}`,
    });
  }

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
    expiresAt:
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? new Date(clock.now().getTime() + expiresIn * 1000)
        : null,
    idToken,
    claims:
      idToken === null
        ? null
        : await verifyIdToken({
            provider: handshake.provider,
            idToken,
            clientId: options.credentials.clientId,
            nonce: handshake.nonce,
            clock,
            keys: options.keys ?? 'token-endpoint-tls',
          }),
  };
}
