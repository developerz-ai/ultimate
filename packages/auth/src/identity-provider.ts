// Single responsibility: the IdentityProvider port — the one shape every federated sign-in
// protocol takes: send the browser out (`begin`), take its answer back (`complete`), hand over one
// proven `OAuthProfile`. OIDC (`oidcIdentityProvider`) and SAML (`samlIdentityProvider`) are its two
// adapters; `signInWithIdentity` is the one way either becomes a session.

import type { Clock } from '@ultimat3/core';
import type { Auth, LoginResult } from './auth';
import { type TotpReplayGuard, totpStep } from './mfa';
import type { OAuthGrantContext } from './oauth-grant-context';
import { type OAuthGrants, signInWithOAuth } from './oauth-login';
import type { OAuthProfile } from './oauth-profile';

export interface IdentityBeginInput {
  /** The absolute URL the IdP answers to: the callback route for this provider. */
  readonly callbackUrl: string;
  readonly clock: Clock;
}

export interface IdentityRedirect {
  /** Where the browser is sent. */
  readonly location: string;
  /**
   * What the second leg must be handed back, opaque to the caller. Not secret from the browser
   * that started the flow, but it must not be FORGEABLE: the routes seal it in a signed cookie.
   */
  readonly state: string;
}

export interface IdentityCompleteInput {
  /** `IdentityRedirect.state`, as the caller sealed and re-opened it. */
  readonly state: string;
  /** The IdP's answer: the callback's query (GET) or form body (POST). */
  readonly params: Readonly<Record<string, string>>;
  /** The same URL `begin` was given. */
  readonly callbackUrl: string;
  readonly clock: Clock;
  /**
   * The single-use claim store: an answer completes ONCE. The routes pass `auth.totpReplay`,
   * the store a framework boot installs shared across replicas (`installTotpReplay`).
   */
  readonly replay: TotpReplayGuard;
}

export interface VerifiedIdentity {
  readonly profile: OAuthProfile;
  /** When the IdP says the federated session ends, if it says. */
  readonly expiresAt: Date | null;
  /** Everything else the IdP asserted — id-token claims or SAML attributes — for the grant seam. */
  readonly claims: Readonly<Record<string, unknown>>;
  /** OIDC only: the token set and a lazy, subject-checked `userinfo()` (`oauthLogin`'s grant seam). */
  readonly oauth?: OAuthGrantContext | undefined;
}

export interface IdentityProvider {
  /** Stable id: the route segment, `OAuthProfile.provider`, and the `x_accounts.provider` value. */
  readonly id: string;
  readonly protocol: 'oidc' | 'saml';
  /** How the IdP returns: SAML's HTTP-POST binding is a cross-site POST, OIDC's a GET. */
  readonly callbackMethod: 'GET' | 'POST';
  begin(input: IdentityBeginInput): Promise<IdentityRedirect>;
  /**
   * Whether `params` answer THIS state — RelayState for SAML, `state` for OIDC — compared in
   * constant time, nothing verified beyond it. The routes clear a browser's state cookie only on an
   * answer bound to it: the ACS cookie rides any cross-site POST, so clearing on every outcome let
   * any site end a sign-in in flight with one junk form.
   */
  answers(state: string, params: Readonly<Record<string, string>>): boolean;
  /** Every refusal is a coded `AuthError`; nothing here creates a session. */
  complete(input: IdentityCompleteInput): Promise<VerifiedIdentity>;
}

/** The app's grant seam over a verified identity — business convention, never shipped (axiom 8). */
export type ResolveIdentityGrants = (
  identity: VerifiedIdentity,
) => Promise<OAuthGrants> | OAuthGrants;

export interface IdentitySignInOptions {
  readonly grants?: OAuthGrants | undefined;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

/**
 * A verified identity → a session, through the same account-link, MFA and session rules an OAuth
 * login runs (`signInWithOAuth`). The provider id must be in `defineAuth({ providers })`.
 */
export async function signInWithIdentity(
  auth: Auth,
  identity: VerifiedIdentity,
  options: IdentitySignInOptions = {},
): Promise<LoginResult> {
  return await signInWithOAuth(auth, {
    profile: identity.profile,
    // The framework stores no provider credential (`accountFor`); only the expiry is carried.
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt: identity.expiresAt,
      idToken: null,
      claims: null,
    },
    ip: options.ip,
    userAgent: options.userAgent,
    ...(options.grants === undefined ? {} : { grants: options.grants }),
  });
}

/**
 * The replay store forgets a claim once its step falls behind the clock, so a claim is filed
 * under the step of the LAST instant the answer is acceptable: it outlives its own window.
 */
export const replayStepFor = (until: Date): number => totpStep(until);
