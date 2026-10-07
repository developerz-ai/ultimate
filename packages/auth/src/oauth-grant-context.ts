// Single responsibility: what `resolveGrants` may read besides the profile (#670). An IdP is free
// to put authorization facts — groups, entitlements, `allowed_oauth_apps` — on `/userinfo` only,
// or in an id-token claim `OAuthProfile` does not name; a seam that sees the profile alone refuses
// a correctly granted user. The token set, the whole verified payload, and a lazy userinfo read.

import { renderFixLiteral } from '@ultimat3/core';
import { decodeJwtSegment } from './json';
import type { OAuthProviderId } from './oauth';
import { oauthExchangeFailed } from './oauth-errors';
import type { OAuthTokens } from './oauth-exchange';
import { oauthStartPath } from './oauth-paths';
import {
  type OAuthProfile,
  type OAuthProfileOptions,
  userinfoAccountId,
  userinfoBody,
} from './oauth-profile';
import { providerFor } from './oauth-registry';

/** The second argument of `resolveGrants`. Read-only, and alive for one callback only. */
export interface OAuthGrantContext {
  readonly provider: OAuthProviderId;
  /**
   * The exchange's token set, in flight. The framework persists none of it (`accountFor` writes
   * `null`), so an app that keeps a token past this call has chosen to store a credential.
   */
  readonly tokens: OAuthTokens;
  /**
   * Every claim of the id token the exchange VERIFIED — custom ones (`hd`, `groups`) included,
   * which `tokens.claims` drops. `null` when the provider issued no id token.
   */
  readonly idTokenClaims: Readonly<Record<string, unknown>> | null;
  /**
   * The provider's userinfo answer, every claim, read with the access token. At most one request
   * per login, however often it is asked: none at all when the profile was already read off
   * userinfo (GitHub), whose body is handed back; a failed read is not remembered.
   * A body naming another subject is `X_OAUTH_EXCHANGE_FAILED` — the same rule `oauthProfile`
   * applies, so a grant can never be read off somebody else's identity.
   */
  userinfo(): Promise<Readonly<Record<string, unknown>>>;
}

/** The verified token's payload, whole. Its signature, `iss`, `aud` and `exp` were checked already. */
function fullPayload(tokens: OAuthTokens): Readonly<Record<string, unknown>> | null {
  if (tokens.claims === null || tokens.idToken === null) return null;
  const payload = decodeJwtSegment(tokens.idToken.split('.')[1] ?? '');
  return payload === null ? null : Object.freeze(payload);
}

async function readUserinfo(
  profile: OAuthProfile,
  tokens: OAuthTokens,
  options: OAuthProfileOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const { provider } = profile;
  // Asked before `userinfoBody`, whose own refusal for this case speaks of a missing identity:
  // here the identity is proven, and what is missing is the endpoint the app's rule reads.
  if (providerFor(provider).userInfoUrl === null) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: `${provider} publishes no userinfo endpoint, so resolveGrants cannot read one`,
      fix: `resolveGrants: (profile, { idTokenClaims }) => grantsFrom(idTokenClaims)   # ${provider} puts its claims in the id token, never behind context.userinfo()`,
    });
  }
  const body = await userinfoBody(provider, tokens, options);
  if (userinfoAccountId(body) !== profile.providerAccountId) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: 'the userinfo subject is not the subject of the identity being signed in',
      fix: `registerOAuthProvider({ id: ${renderFixLiteral(provider, '<id>')}, userInfoUrl: '<the provider's own userinfo endpoint>', … })   # a proxy that rewrites sub is refused; then restart at ${oauthStartPath(provider)}`,
    });
  }
  return Object.freeze(body);
}

/**
 * Built once per callback, after the profile is proven and before `resolveGrants` runs. `fetched`
 * is the userinfo body the profile read already made, if it made one — its subject IS the profile's.
 */
export function oauthGrantContext(
  profile: OAuthProfile,
  tokens: OAuthTokens,
  options: OAuthProfileOptions,
  fetched: Record<string, unknown> | null = null,
): OAuthGrantContext {
  let pending: Promise<Readonly<Record<string, unknown>>> | undefined =
    fetched === null ? undefined : Promise.resolve(Object.freeze(fetched));
  return Object.freeze({
    provider: profile.provider,
    tokens,
    idTokenClaims: fullPayload(tokens),
    userinfo() {
      if (pending === undefined) {
        const read = readUserinfo(profile, tokens, options);
        pending = read;
        // Forget a failure, so a seam that retries asks the provider again rather than the cache.
        read.catch(() => {
          if (pending === read) pending = undefined;
        });
      }
      return pending;
    },
  });
}
