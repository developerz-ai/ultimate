// Single responsibility: `oauthLogin(auth)` — "log in with GitHub" in one call, as a front door
// over the ONE sign-in route implementation (`identity-provider-route-core.ts`): every registered
// OAuth provider this app enabled becomes an `oidcIdentityProvider` per request, so OAuth and SAML
// share the paths (`/auth/sso/:provider`), the sealed state cookie and the refusal body.
//
// A route DESCRIPTOR, never a mounted handler, for the reason `mcpHttpRoute()` is one:
// `@ultimat3/http` is tier 2 like this package, so auth may not import it — and `defineRoute`
// is tier 4 and describes a rendered page. A bare `Request` in, a `Response` out, drivable from
// a test and mountable by any router that can match a `:param`.

import {
  ConfigInvalidError,
  isUltimateError,
  logger,
  renderThrowable,
  type UltimateError,
} from '@ultimat3/core';
import type { Auth } from './auth';
import { oidcIdentityProvider } from './identity-provider-oidc';
import {
  type SignInRouteDescriptor,
  type SignInRouteMeta,
  signInRoutes,
} from './identity-provider-route-core';
import type { IdTokenKeys } from './jwks';
import type { OAuthProviderId } from './oauth';
import { BUILTIN_OAUTH_PROVIDER_IDS } from './oauth-builtins';
import { oauthExchangeFailed, oauthProviderUnknown } from './oauth-errors';
import type { OAuthClientCredentials, OAuthFetch } from './oauth-exchange';
import { oauthCredentials } from './oauth-exchange';
import type { ResolveOAuthGrants } from './oauth-login';
import { hasOAuthProvider } from './oauth-registry';
import { callbackPath } from './sign-in-callback-path';

/**
 * What a router needs to mount one of these. Structural, like `RequestLike` in `session.ts`:
 * `@ultimat3/http` binds to this shape, this package never binds to `@ultimat3/http`.
 */
export interface AuthRouteDescriptor {
  readonly method: 'GET';
  /** The mount pattern, `:provider` included. The handler re-reads it off the request itself. */
  readonly path: string;
  /** Stable id for a route table, a trace and the manifest. */
  readonly name: string;
  /** Both legs are public by definition — they are how an anonymous visitor stops being one. */
  readonly auth: 'public';
  /** What a router mounts as the route's `meta`, verbatim: `meta: leg.meta`. */
  readonly meta: SignInRouteMeta;
  handle(request: Request): Promise<Response>;
}

export interface OAuthLoginRoutes {
  readonly start: AuthRouteDescriptor;
  readonly callback: AuthRouteDescriptor;
}

export interface OAuthLoginOptions {
  /**
   * The origin the provider redirects back to. Defaults to `APP_URL`; with neither, the start leg
   * refuses (`X_ENV_MISSING`). Never the request's own origin: that is the `Host` header, which
   * the caller writes.
   */
  readonly baseUrl?: string | undefined;
  /** Defaults to the two env vars in the provider table, read per request, never at import. */
  readonly credentials?: OAuthClientCredentials | undefined;
  /** Defaults to `SESSION_SECRET`. Seals the handshake across the two requests. */
  readonly secret?: string | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Where a signed-in browser lands. A fixed path — never read from the request. See below. */
  readonly successPath?: string | undefined;
  /** Narrower scopes than the provider's defaults, when the app wants less. */
  readonly scopes?: readonly string[] | undefined;
  /**
   * The client address recorded on the session. Defaults to none: the only honest source is a
   * trusted-proxy chain, and this package cannot see one. `@ultimat3/http` can, and passes it.
   */
  readonly clientIp?: ((request: Request) => string | null | undefined) | undefined;
  /**
   * What the IdP's answer entitles this identity to. **Omit it and a first-time SSO user is
   * created with `roles: []` and `orgId: null`** — an actor every `can()` denies, and a
   * tenant-scoped read that throws `X_TENANCY_ACTOR_ORG_REQUIRED` before the query is built. SSO
   * "works" and the person can do nothing until somebody runs SQL.
   *
   * A seam and not a group-to-role table, because which IdP group means which role is business
   * convention and business convention never ships (axiom 8). The framework's part is calling it
   * on every login, so removing somebody from a group in the IdP takes effect at their next
   * sign-in rather than never.
   */
  readonly resolveGrants?: ResolveOAuthGrants | undefined;
  /**
   * What each provider's id token signature is checked against, asked per callback. Omit it and
   * the callback verifies against the provider's published key set (`providerJwks`) whenever it
   * has a `jwksUri` — token-endpoint TLS only for one that publishes none. Return
   * `'token-endpoint-tls'` to opt a provider out, a `jwksClient({ jwksUri })` to pin another set,
   * or `undefined` to leave that provider on the default. `undefined` is the safe "everyone else"
   * branch: `providerJwks(providerFor('github'))` throws, because GitHub publishes no `jwks_uri`.
   */
  readonly idTokenKeys?: ((provider: OAuthProviderId) => IdTokenKeys | undefined) | undefined;
  /**
   * The callback leg's mount pattern, one whole `:provider` segment — and so the `redirect_uri`
   * every provider is sent and must have registered. Defaults to `OAUTH_CALLBACK_ROUTE_PATH`
   * (`/auth/sso/:provider/callback`). Set it to keep a URI already registered at an IdP you cannot
   * edit, e.g. 30.x's `'/auth/oauth/:provider/callback'`, and mount `callback.path`, never the
   * constant. The start leg does not move: it is a link in your own page, and `fix:` lines name it.
   * A pattern a router cannot mount is `X_CONFIG_INVALID` here, at the call.
   */
  readonly callbackPath?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * A throw with no code: a bug in an `AuthAdapter` or an `OAuthFetch` this package does not own.
 * Its text goes to the LOG and never into the response — a pool error carrying a connection
 * string was once served to whoever typed the URL. `renderThrowable`, never `error.message`.
 */
function uncoded(error: unknown): UltimateError {
  logger.error('auth.oauth.uncoded_failure', { detail: renderThrowable(error) });
  return oauthExchangeFailed({
    provider: 'oauth',
    stage: 'token',
    detail:
      'an adapter or fetch this package does not own threw a value with no error code; the ' +
      'detail is in this process log under auth.oauth.uncoded_failure',
    fix: 'throw an UltimateError from the AuthAdapter or OAuthFetch that failed — the factories are in packages/auth/src/errors.ts, and the OAuth ones in packages/auth/src/oauth-errors.ts',
  });
}

/**
 * Unknown and not-enabled are one 404, listing the BUILT-INS only: the caller is an anonymous
 * stranger, and the live registry is this deployment's own vocabulary.
 */
const unknown = (segment: string): UltimateError =>
  oauthProviderUnknown(segment, BUILTIN_OAUTH_PROVIDER_IDS);

/**
 * The credentials for a provider, or the SAME 404 an unknown provider gets.
 *
 * `assertEnabled` collapses "never heard of it" and "not enabled here" into one answer so an
 * anonymous caller cannot enumerate this deployment's configuration. Past it, `oauthCredentials`
 * threw `X_ENV_MISSING` and `problem()` answered 500 — publishing the app's own environment
 * variable names in the `cause` and, worse, restoring the oracle: 500 meant "registered here",
 * 404 meant "not". A provider with no credentials is not usable, which is the only thing this
 * caller is entitled to learn.
 *
 * The real cause is not lost: `X_ENV_MISSING`'s `cause` and `fix` are the operator's, and they go
 * to the process log where only an operator can read them.
 */
function credentialsFor(
  provider: OAuthProviderId,
  options: OAuthLoginOptions,
): OAuthClientCredentials {
  if (options.credentials !== undefined) return options.credentials;
  try {
    return oauthCredentials(provider, options.env ?? Bun.env);
  } catch (error) {
    if (!isUltimateError(error) || error.code !== 'X_ENV_MISSING') throw error;
    logger.error('auth.oauth.credentials_missing', {
      provider,
      cause: error.cause,
      fix: error.fix,
    });
    throw unknown(provider);
  }
}

/** A descriptor of a GET leg, narrowed to the `AuthRouteDescriptor` the type has always promised. */
const asGet = (descriptor: SignInRouteDescriptor): AuthRouteDescriptor =>
  Object.freeze({ ...descriptor, method: 'GET' as const });

/**
 * The two routes. Mount them and "log in with GitHub" is a button pointing at
 * `/auth/sso/github` — no handshake store, no PKCE bookkeeping, no state check to forget.
 *
 * ```ts
 * const { start, callback } = oauthLogin(auth);
 * // start.path    → '/auth/sso/:provider'
 * // callback.path → '/auth/sso/:provider/callback'
 * ```
 */
export function oauthLogin(auth: Auth, options: OAuthLoginOptions = {}): OAuthLoginRoutes {
  const routes = signInRoutes(auth, options, {
    callbackPath: callbackPath(options.callbackPath),
    resolve(segment, leg) {
      if (!hasOAuthProvider(segment) || !auth.providers.includes(segment)) throw unknown(segment);
      // Asked on the callback only: the start leg verifies nothing.
      const keys = leg === 'callback' ? options.idTokenKeys?.(segment) : undefined;
      return oidcIdentityProvider({
        provider: segment,
        credentials: credentialsFor(segment, options),
        scopes: options.scopes,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        ...(keys === undefined ? {} : { idTokenKeys: keys }),
      });
    },
    unknown,
    event: 'auth.oauth',
    names: { start: 'auth.oauth.start', callback: 'auth.oauth.callback', acs: 'auth.oauth.acs' },
    uncoded,
    grants(identity) {
      const resolve = options.resolveGrants;
      if (resolve === undefined) return undefined;
      if (identity.oauth === undefined) {
        throw new ConfigInvalidError({
          cause: `${identity.profile.provider} returned no OAuth grant context, so resolveGrants(profile, context) cannot be called`,
          fix: 'identityProviderRoutes(auth, { providers, resolveGrants: (identity) => ({ roles }) })  // for a provider that is not OAuth',
        });
      }
      return resolve(identity.profile, identity.oauth);
    },
  });
  return Object.freeze({ start: asGet(routes.start), callback: asGet(routes.callback) });
}
