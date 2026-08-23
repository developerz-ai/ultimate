// Single responsibility: the OAuth half of this package's error factories — every refusal a
// provider handshake can produce, and the one phrase their fixes are built from.
// Split from `errors.ts` at the 500-line ceiling; the codes, the titles and the single
// `registerErrorCodes()` call stay there, so this file adds no code and registers nothing.

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
 * The provider came back with `error=` and no code — almost always the user pressing Cancel.
 * A separate code from `X_OAUTH_EXCHANGE_FAILED` on purpose: nothing was exchanged, nothing is
 * misconfigured, and folding the single commonest non-success outcome of a login into the code
 * that means "the client secret is wrong" makes both unreadable in a log and pages the wrong person.
 */
export const oauthDenied = (
  provider: string,
  reason: string,
  description: string | null,
): AuthError =>
  new AuthError({
    code: 'X_OAUTH_DENIED',
    // `reason` and `description` are query parameters off the callback URL — whatever the browser
    // was redirected with, newlines and quotes included. `renderCauseValue` renders them as JSON
    // string literals, so a forged `error_description` cannot forge a second log line or break the
    // sentence around it. Both are already `string` by type: this is escaping, not throw-safety.
    cause: `${provider} declined the authorization: ${renderCauseValue(reason)}${
      description === null ? '' : ` (${renderCauseValue(description)})`
    }`,
    fix: `${restartAt(provider)} and approve the ${provider} consent screen`,
    meta: { provider, reason },
  });

/**
 * A URL segment naming a provider no `registerOAuthProvider` call has claimed, or one that is but
 * was left out of `defineAuth({ providers })`. One refusal for both: which of the two it is
 * describes the app's configuration to an unauthenticated caller, and the fix is the same sentence
 * either way.
 *
 * **`supported` is the CALLER's to scope, because the two callers have two audiences.**
 * `oauth-route.ts` passes `BUILTIN_OAUTH_PROVIDER_IDS` — its reader is an anonymous stranger who
 * typed a URL, and the three built-ins are a framework constant already in the public docs, while
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

/**
 * Two `registerOAuthProvider` calls claiming one id. A silent replacement would let whichever
 * module imported second decide where every login for that id goes — including which `issuers`
 * an id token may claim — so the second registration refuses at boot instead.
 */
export const oauthProviderDuplicate = (provider: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_PROVIDER_DUPLICATE',
    cause: `an oauth provider is already registered as ${renderCauseValue(provider)}, so the second registration would silently replace the first`,
    fix: `give one of them a different id, or delete the duplicate registerOAuthProvider({ id: ${renderFixLiteral(provider, '<id>')} }) call`,
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

/**
 * The address is proven to the provider, and an account that never proved it already holds it.
 * Naming that is not account enumeration — this caller just demonstrated they own the address —
 * and staying silent would leave them with a login that fails forever and no way out.
 *
 * The address itself rides in `meta`, never in `cause`: a log pipeline can redact a field by
 * key, and cannot redact an address that was already interpolated into a sentence.
 */
export const oauthAccountNotLinked = (provider: string, email: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `an account holds this ${provider} address but never verified it, so ${provider} may not claim it`,
    fix: `sign in with that account's password and confirm the email-verify link, then retry ${provider}`,
    meta: { provider, email },
  });

/**
 * `link: 'never'` and a local account already holds the address. Same code and same disclosure
 * rule as `oauthAccountNotLinked` — the caller proved to the provider that the address is theirs,
 * so naming the collision is not enumeration — and the address rides in `meta`, never in `cause`.
 */
export const oauthLinkingDisabled = (provider: string, email: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `an account already holds this address and defineAuth({ link: 'never' }) forbids ${provider} from claiming it`,
    fix: "sign in with that account's own credentials, or set link: 'verified-email' in defineAuth to let a provider-verified address claim a locally-verified account",
    meta: { provider, email },
  });

/**
 * `CreateUserInput` carries no `emailVerifiedAt`, so a provider-verified address takes a second
 * write. Falling back to the unstamped row would mint a session for a user every later login
 * reads as unverified — the exact state `resolveUser` refuses to link a provider to — so the
 * flow fails closed on an adapter that loses the stamp instead of half-succeeding.
 */
export const emailVerifiedNotStored = (provider: string, userId: string): AuthError =>
  new AuthError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `the adapter returned no row for new user ${userId}, so the ${provider}-verified address was never stamped verified`,
    fix: 'return the updated row from AuthAdapter.updateUser — MemoryAdapter.updateUser is the reference implementation',
    meta: { provider, userId },
  });

/** The token arrived, and is not one this handshake can trust: wrong `iss`, `aud`, or expired. */
export const oauthTokenInvalid = (provider: string, reason: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_OAUTH_TOKEN_INVALID',
    cause: `${provider} id token rejected: ${reason}`,
    fix,
    meta: { provider },
  });
