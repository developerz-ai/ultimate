// Single responsibility: a registered OAuth2/OIDC provider as an `IdentityProvider` — the existing
// handshake (`beginOAuth`), exchange (`exchangeOAuthCode`) and profile read (`readOAuthProfile`)
// behind the port, no protocol of its own. The port adds one thing: the handshake's `state` is
// claimed ONCE in the shared replay store, keyed on when it was issued, before the code is spent.

import { timingSafeEqual } from '@ultimat3/core';
import {
  type IdentityProvider,
  type IdentityRedirect,
  replayStepFor,
  type VerifiedIdentity,
} from './identity-provider';
import { isRecord } from './json';
import type { IdTokenKeys } from './jwks';
import {
  assertOAuthCallback,
  beginOAuth,
  type OAuthHandshake,
  type OAuthProviderId,
} from './oauth';
import { DEFAULT_HANDSHAKE_TTL_MS } from './oauth-cookie';
import { oauthDenied, oauthStateInvalid } from './oauth-errors';
import {
  exchangeOAuthCode,
  type OAuthClientCredentials,
  type OAuthFetch,
  oauthCredentials,
} from './oauth-exchange';
import { oauthGrantContext } from './oauth-grant-context';
import { readOAuthProfile } from './oauth-profile';

export interface OidcIdentityProviderConfig {
  /** A registered `OAuthProvider` id (`registerOAuthProvider`, or a built-in). */
  readonly provider: OAuthProviderId;
  /** Default: the provider's two env vars, read per call, never at import. */
  readonly credentials?: OAuthClientCredentials | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly idTokenKeys?: IdTokenKeys | undefined;
}

const FIELDS = ['state', 'nonce', 'verifier', 'redirectUri', 'authorizeUrl'] as const;

/** The handshake, and when it was issued — the instant its single-use claim is keyed on. */
export interface StoredHandshake {
  readonly handshake: OAuthHandshake;
  readonly issuedAt: number;
}

/**
 * The handshake as the sign-in state string. The ONE encoding: `begin` writes it, and so does
 * `handshakeCookie`, so a hand-built leg and a built-in one read each other's cookie.
 */
export const encodeOidcState = (handshake: OAuthHandshake, issuedAt: number): string =>
  JSON.stringify({
    ...Object.fromEntries(FIELDS.map((field) => [field, handshake[field]])),
    issuedAt,
  });

/** `encodeOidcState`'s inverse, bound to `provider`; `X_OAUTH_STATE_INVALID` for anything else. */
export function decodeOidcState(provider: OAuthProviderId, state: string): StoredHandshake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    parsed = null;
  }
  if (
    !isRecord(parsed) ||
    !FIELDS.every((field) => typeof parsed[field] === 'string') ||
    typeof parsed['issuedAt'] !== 'number' ||
    !Number.isFinite(parsed['issuedAt'])
  ) {
    throw oauthStateInvalid(provider, 'the stored handshake is not a handshake');
  }
  const field = (name: (typeof FIELDS)[number]): string => String(parsed[name]);
  return {
    issuedAt: parsed['issuedAt'],
    handshake: {
      provider,
      state: field('state'),
      nonce: field('nonce'),
      verifier: field('verifier'),
      redirectUri: field('redirectUri'),
      authorizeUrl: field('authorizeUrl'),
    },
  };
}

export function oidcIdentityProvider(config: OidcIdentityProviderConfig): IdentityProvider {
  const id = config.provider;
  const credentials = (): OAuthClientCredentials => config.credentials ?? oauthCredentials(id);
  const provider: IdentityProvider = {
    id,
    protocol: 'oidc',
    callbackMethod: 'GET',
    async begin({ callbackUrl, clock }): Promise<IdentityRedirect> {
      const handshake = beginOAuth({
        provider: id,
        clientId: credentials().clientId,
        redirectUri: callbackUrl,
        scopes: config.scopes,
      });
      const state = encodeOidcState(handshake, clock.now().getTime());
      return { location: handshake.authorizeUrl, state };
    },
    answers(state, params) {
      try {
        return timingSafeEqual(decodeOidcState(id, state).handshake.state, params['state'] ?? '');
      } catch {
        return false;
      }
    },
    async complete({ state, params, callbackUrl, clock, replay }): Promise<VerifiedIdentity> {
      const { handshake, issuedAt } = decodeOidcState(id, state);
      if (handshake.redirectUri !== callbackUrl) {
        throw oauthStateInvalid(id, 'the handshake was started for another callback URL');
      }
      const declined = params['error'];
      if (declined !== undefined && declined !== '') {
        throw oauthDenied(id, declined, params['error_description'] ?? null);
      }
      const callback = { state: params['state'] ?? '', code: params['code'] ?? '' };
      // The state check first, so a forged callback cannot spend the real browser's handshake.
      assertOAuthCallback(handshake, callback);
      const now = clock.now();
      // Keyed on when the handshake was ISSUED, the way SAML's claim is keyed on NotOnOrAfter: a
      // horizon read off `now` moved with every retry, so each 30 s step was a fresh claim row.
      const horizon = new Date(issuedAt + DEFAULT_HANDSHAKE_TTL_MS);
      if (horizon.getTime() < now.getTime()) {
        throw oauthStateInvalid(id, 'the handshake expired before the provider answered');
      }
      if (!(await replay.claim(`oidc:${id}:${handshake.state}`, replayStepFor(horizon), now))) {
        throw oauthStateInvalid(id, 'this handshake was already completed');
      }
      const options = { fetch: config.fetch, timeoutMs: config.timeoutMs };
      const tokens = await exchangeOAuthCode(handshake, callback, {
        credentials: credentials(),
        clock,
        ...options,
        keys: config.idTokenKeys,
      });
      const { profile, userinfo } = await readOAuthProfile(id, tokens, options);
      const oauth = oauthGrantContext(profile, tokens, options, userinfo);
      return { profile, expiresAt: tokens.expiresAt, claims: oauth.idTokenClaims ?? {}, oauth };
    },
  };
  return Object.freeze(provider);
}
