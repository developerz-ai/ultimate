// Single responsibility: one normalised identity out of whichever surface the provider offers.
// The rule is single: claims from a verified id token when there is one, the userinfo endpoint
// when there is not. `emailVerified` is carried honestly rather than assumed — it is what
// decides whether this login may attach itself to an existing account by address.

import { logger } from '@ultimat3/core';
import { oauthExchangeFailed } from './errors';
import { idTokenEmailVerified, isVerifiedFlag } from './id-token';
import { OAUTH_PROVIDERS, type OAuthProviderId } from './oauth';
import {
  OAUTH_USER_AGENT,
  type OAuthFetch,
  type OAuthTokens,
  providerDetail,
} from './oauth-exchange';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface OAuthProfile {
  readonly provider: OAuthProviderId;
  /** The provider's own stable id (`sub`, or GitHub's numeric id). Never the email. */
  readonly providerAccountId: string;
  readonly email: string | null;
  /** Only a provider-asserted verification counts. Defaults to false, never to true. */
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface OAuthProfileOptions {
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

interface GithubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

async function getJson(
  provider: OAuthProviderId,
  url: string,
  accessToken: string,
  options: OAuthProfileOptions,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; detail: string }> {
  const doFetch: OAuthFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': OAUTH_USER_AGENT,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: error instanceof Error ? error.message : 'the request failed before a response',
      fix: `check egress to ${new URL(url).host} from this host, then restart the flow`,
    });
  }
  if (!response.ok) {
    return { ok: false, status: response.status, detail: await providerDetail(response) };
  }
  return { ok: true, body: await response.json().catch(() => undefined) };
}

/** GitHub keeps a private primary address off the profile; this is where it actually lives. */
async function githubPrimaryEmail(
  url: string,
  accessToken: string,
  options: OAuthProfileOptions,
): Promise<GithubEmail | null> {
  const result = await getJson('github', url, accessToken, options);
  if (!result.ok) {
    logger.warn('auth.oauth.github_emails_unavailable', {
      status: result.status,
      detail: result.detail,
    });
    return null;
  }
  const entries = Array.isArray(result.body) ? result.body : [];
  const verified = entries.filter(
    (entry): entry is GithubEmail =>
      isRecord(entry) &&
      typeof entry['email'] === 'string' &&
      entry['verified'] === true &&
      typeof entry['primary'] === 'boolean',
  );
  return verified.find((entry) => entry.primary) ?? verified[0] ?? null;
}

async function fromUserInfo(
  provider: OAuthProviderId,
  tokens: OAuthTokens,
  options: OAuthProfileOptions,
): Promise<OAuthProfile> {
  const config = OAUTH_PROVIDERS[provider];
  const url = config.userInfoUrl;
  if (url === null) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: `${provider} publishes no userinfo endpoint and its id token carried no identity`,
      fix: `request the "email" scope for ${provider} in beginOAuth(), then restart the flow`,
    });
  }

  const result = await getJson(provider, url, tokens.accessToken, options);
  if (!result.ok) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: result.detail,
      status: result.status,
      fix: `confirm the ${provider} app still grants ${config.scopes.join(' ')}, then restart the flow`,
    });
  }
  if (!isRecord(result.body)) {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: 'the userinfo endpoint answered 200 with a body that is not a JSON object',
      fix: `confirm ${url} is the provider's real userinfo endpoint and not a proxy`,
    });
  }

  const body = result.body;
  // GitHub's id is a number; OIDC's `sub` is a string. Both are stable, so both are accepted.
  const rawId = body['sub'] ?? body['id'];
  const providerAccountId =
    typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId : '';
  if (providerAccountId === '') {
    throw oauthExchangeFailed({
      provider,
      stage: 'userinfo',
      detail: 'the profile carried no stable account id',
      fix: `confirm the ${provider} app requests ${config.scopes.join(' ')} and restart the flow`,
    });
  }

  let email = stringOrNull(body['email']);
  let emailVerified = isVerifiedFlag(body['email_verified']);

  if (config.userEmailsUrl !== null) {
    const primary = await githubPrimaryEmail(config.userEmailsUrl, tokens.accessToken, options);
    if (primary !== null) {
      email = primary.email;
      emailVerified = true;
    }
  }

  return {
    provider,
    providerAccountId,
    email,
    emailVerified,
    name: stringOrNull(body['name']) ?? stringOrNull(body['login']),
  };
}

/**
 * The id token is preferred because it was verified during the exchange and costs no round
 * trip. Userinfo is the fallback for a provider that issues no id token (GitHub) and for the
 * narrowed-scope case where the token identifies a subject but carries no address.
 */
export async function oauthProfile(
  provider: OAuthProviderId,
  tokens: OAuthTokens,
  options: OAuthProfileOptions = {},
): Promise<OAuthProfile> {
  const claims = tokens.claims;
  if (claims === null) return await fromUserInfo(provider, tokens, options);

  const email = stringOrNull(claims.email);
  const userInfoUrl = OAUTH_PROVIDERS[provider].userInfoUrl;
  if (email === null && userInfoUrl !== null) {
    const profile = await fromUserInfo(provider, tokens, options);
    // Two surfaces, one identity — or this is not that identity. Overwriting the subject and
    // keeping the address would link the account on an address belonging to whoever the second
    // call described, so a disagreement ends the handshake instead of being reconciled.
    if (profile.providerAccountId !== claims.sub) {
      throw oauthExchangeFailed({
        provider,
        stage: 'userinfo',
        detail: 'the userinfo subject is not the subject of the verified id token',
        fix: `confirm ${userInfoUrl} is ${provider}'s own userinfo endpoint and not a proxy that rewrites sub`,
      });
    }
    return profile;
  }

  return {
    provider,
    providerAccountId: claims.sub,
    email,
    emailVerified: email !== null && idTokenEmailVerified(claims),
    name: stringOrNull(claims.name),
  };
}
