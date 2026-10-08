// Single responsibility: the OAuth refusals more than one OAuth module raises, and the one phrase
// every "start over" fix is built from. A refusal with one thrower lives beside it (`oauthDenied`
// in `oauth-route.ts`, the linking ones in `oauth-login.ts`); the codes, titles and the single
// `registerErrorCodes()` call stay in `errors.ts`, so this file adds no code and registers nothing.

import { renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import { AuthError } from './errors';
import { oauthStartPath } from './oauth-paths';

/**
 * The `fix:` quotes `oauthStartPath` rather than a hand-written path. That is not tidiness: this
 * line shipped naming `GET /auth/oauth/<provider>` while `@ultimat3/auth` mounted no route at all,
 * so every caller who followed it hit a 404. One declaration, read by the mount and by the fix,
 * is what stops that recurring — `oauthLogin()` cannot move without moving this sentence.
 */
export const oauthStateInvalid = (provider: string, part: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_STATE_INVALID',
    cause: `${provider} callback rejected: ${part}`,
    fix: `${restartAt(provider)} — a callback URL is single-use`,
    meta: { provider },
  });

/** The one phrase every "start over" fix is built from, so none of them can name a dead route. */
export const restartAt = (provider: string): string =>
  `restart the flow at GET ${oauthStartPath(provider)}`;

/**
 * A URL segment naming a provider no `registerOAuthProvider` call has claimed, or one that is but
 * was left out of `defineAuth({ providers })`. One refusal for both: which of the two it is
 * describes the app's configuration to an unauthenticated caller, and the fix is the same sentence
 * either way.
 *
 * **`supported` is the CALLER's to scope, because the two callers have two audiences.**
 * `oauth-route.ts` passes `BUILTIN_OAUTH_PROVIDER_IDS` — its reader is an anonymous stranger who
 * typed a URL, and the two built-ins are a framework constant already in the public docs, while
 * the live registry holds whatever internal OP this deployment registered. `providerFor()` passes
 * `oauthProviderIds()` — its reader is a developer holding a stack trace, and there the full list
 * is exactly what makes the fix runnable. Neither ever passes `defineAuth({ providers })`: naming
 * what this deployment turned on is the disclosure the shared refusal exists to prevent.
 *
 * The fix names `registerOAuthProvider` first so it stays executable for the branch the narrowed
 * list cannot cover — a segment nothing registered cannot be added to `providers` at all, so
 * "add it" alone was an instruction that could not be followed.
 *
 * The segment itself is a URL path the caller typed, so it goes through `renderCauseValue` in the
 * sentence and `renderFixLiteral` in the command — a fix has to parse after a hostile value lands
 * in it.
 */
export const oauthProviderUnknown = (provider: string, supported: readonly string[]): AuthError =>
  new AuthError({
    code: 'X_OAUTH_PROVIDER_UNKNOWN',
    cause: `no oauth provider is mounted at ${renderCauseValue(oauthStartPath(provider))}`,
    fix: `registerOAuthProvider({ id: ${renderFixLiteral(provider, '<id>')} }) if it is not built in, then add that id to defineAuth({ providers: [...] }) — known here: ${supported.map((id) => `'${id}'`).join(', ')}`,
    meta: { provider },
  });

export interface OAuthExchangeFailure {
  readonly provider: string;
  /**
   * Which leg of the server-to-server conversation failed. `discovery` and `jwks` are the two
   * boot/verification legs an enterprise OP adds: reading `/.well-known/openid-configuration`,
   * and reading the key set an id token's signature is checked against.
   */
  readonly stage: 'token' | 'userinfo' | 'discovery' | 'jwks';
  readonly detail: string;
  readonly status?: number | undefined;
  readonly fix: string;
}

/**
 * Deliberately specific, unlike every credential error above it. This one describes a
 * conversation between two servers — naming the stage, the provider and its own status
 * discloses nothing about any user, and is the difference between a fixable misconfiguration
 * and a shrug.
 */
export const oauthExchangeFailed = (failure: OAuthExchangeFailure): AuthError =>
  new AuthError({
    code: 'X_OAUTH_EXCHANGE_FAILED',
    cause:
      `${failure.provider} ${failure.stage} request failed` +
      `${failure.status === undefined ? '' : ` with HTTP ${failure.status}`}: ${failure.detail}`,
    fix: failure.fix,
    meta: {
      provider: failure.provider,
      stage: failure.stage,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    },
  });

/** The token arrived, and is not one this handshake can trust: wrong `iss`, `aud`, or expired. */
export const oauthTokenInvalid = (provider: string, reason: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_TOKEN_INVALID',
    cause: `${provider} id token rejected: ${reason}`,
    fix,
    meta: { provider },
  });
