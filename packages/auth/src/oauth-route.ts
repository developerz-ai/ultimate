// Single responsibility: the two HTTP routes the OAuth library functions have always been
// missing — the redirect out and the callback back — mounted at one fixed pair of paths so the
// `fix:` lines that name them cannot go stale. Everything below composes `beginOAuth`,
// `handshakeCookie` and `completeOAuthLogin`; no new protocol lives here.
//
// A route DESCRIPTOR, never a mounted handler, for the reason `mcpHttpRoute()` is one:
// `@ultimat3/http` is tier 2 like this package, so auth may not import it — and `defineRoute`
// is tier 4 and describes a rendered page. A bare `Request` in, a `Response` out, drivable from
// a test and mountable by any router that can match a `:param`.

import { type Clock, isUltimateError, renderThrowable, type UltimateError } from '@ultimat3/core';
import type { Auth, LoginResult } from './auth';
import { oauthDenied, oauthExchangeFailed, oauthProviderUnknown } from './errors';
import { beginOAuth, type OAuthProviderId } from './oauth';
import { BUILTIN_OAUTH_PROVIDER_IDS } from './oauth-builtins';
import { clearHandshakeCookie, handshakeCookie, readHandshakeCookie } from './oauth-cookie';
import type { OAuthClientCredentials, OAuthFetch } from './oauth-exchange';
import { oauthCredentials } from './oauth-exchange';
import { completeOAuthLogin, type ResolveOAuthGrants } from './oauth-login';
import {
  OAUTH_CALLBACK_ROUTE_PATH,
  OAUTH_START_ROUTE_PATH,
  oauthCallbackPath,
} from './oauth-paths';
import { hasOAuthProvider } from './oauth-registry';

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
  handle(request: Request): Promise<Response>;
}

export interface OAuthLoginRoutes {
  readonly start: AuthRouteDescriptor;
  readonly callback: AuthRouteDescriptor;
}

export interface OAuthLoginOptions {
  /**
   * The origin the provider redirects back to. Defaults to `APP_URL`, then to the request's own
   * origin — which is the `Host` header, so it is preferred last: a forged one only ever produces
   * a `redirect_uri` the provider refuses, but naming the canonical origin costs nothing.
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
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * HTTP status per code, for a descriptor driven OUTSIDE a pipeline — a bare `Request` in, a
 * `Response` out, which is the whole point of a descriptor. `@ultimat3/http`'s `error-map.ts` OWNS
 * these numbers and is where a new one is declared; this package is the same tier and can never
 * import it, so the table is a copy the pin `scripts/oauth-route-status.test.ts` holds identical to
 * `statusFor()`. Everything absent is the provider's fault until proven otherwise: 502.
 */
export const OAUTH_ROUTE_STATUS: Readonly<Record<string, number>> = {
  X_OAUTH_PROVIDER_UNKNOWN: 404,
  X_OAUTH_DENIED: 403,
  X_OAUTH_STATE_INVALID: 400,
  X_OAUTH_TOKEN_INVALID: 400,
  X_UNAUTHENTICATED: 401,
  X_MFA_REQUIRED: 401,
  X_ACCOUNT_LOCKED: 429,
  X_ENV_MISSING: 500,
  X_CONFIG_INVALID: 500,
};

/**
 * What an anonymous caller is allowed to read. `UltimateError.toJSON()` carries `meta` and `stack`
 * — a developer's fields — and BOTH legs of this flow are public by definition, so serialising it
 * whole published a stack trace and whatever a factory put in `meta` to whoever typed the URL. Four
 * fields, the same four on every code: no per-code judgement about which `meta` key is safe today.
 */
const publicBody = (coded: UltimateError): Record<string, string> => ({
  code: coded.code,
  title: coded.title,
  cause: coded.cause,
  fix: coded.fix,
  docs: coded.docs,
});

/**
 * Failure is JSON, never a redirect to a login page carrying `?error=`. A callback is the one
 * request in the flow whose failure the developer has to read, and a redirect that drops the code
 * and the fix line is exactly how three dead `fix:` strings survived a whole release. An app that
 * wants a rendered page wraps these two descriptors; the framework ships the debuggable answer.
 */
function problem(error: unknown, extraCookies: readonly string[]): Response {
  const coded = isUltimateError(error)
    ? error
    : oauthExchangeFailed({
        provider: 'oauth',
        stage: 'token',
        // `renderThrowable`, never `error.message`: the throw came from an adapter or a `fetch`
        // this package does not own, and a getter on `message` — or a `Proxy` trapping
        // `getPrototypeOf` — would make the callback's last answer throw instead of send.
        detail: renderThrowable(error),
        fix: 'throw an UltimateError from the AuthAdapter or OAuthFetch that failed — the factories are in packages/auth/src/errors.ts',
      });
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  for (const cookie of extraCookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(publicBody(coded)), {
    // 502 is the default: an uncoded throw on this path came out of the provider conversation.
    status: OAUTH_ROUTE_STATUS[coded.code] ?? 502,
    headers,
  });
}

/** `/auth/oauth/github` → `github`; `/auth/oauth/github/callback` → `github`. */
function providerSegment(request: Request, leg: 'start' | 'callback'): string {
  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const index = leg === 'start' ? segments.length - 1 : segments.length - 2;
  return segments[index] ?? '';
}

/**
 * Both halves of "is this a provider", in one refusal. An unknown segment and a known provider
 * the app left out of `defineAuth({ providers })` are the same 404 on purpose — telling an
 * anonymous caller which of the two it hit describes the app's configuration for free.
 *
 * The list in the refusal is the THREE BUILT-INS, never the live registry and never
 * `defineAuth({ providers })`. Both of the latter are this deployment's own configuration, and
 * this caller is an anonymous stranger who typed a URL: an app that registered an internal OP has
 * put its own vocabulary into the registry, and echoing it back names a system the stranger had no
 * way to know exists. The built-in list is a framework constant already in the public docs, so it
 * discloses nothing while still making the fix executable — and `registerOAuthProvider` in the
 * same sentence covers the other branch without enumerating anything.
 *
 * `providerFor()` keeps the full registered list for the same reason in reverse: its reader is a
 * developer holding a stack trace, and there the list is exactly what makes the fix runnable.
 */
function assertEnabled(auth: Auth, segment: string): OAuthProviderId {
  const supported = BUILTIN_OAUTH_PROVIDER_IDS;
  if (!hasOAuthProvider(segment)) throw oauthProviderUnknown(segment, supported);
  const provider: OAuthProviderId = segment;
  if (!auth.providers.includes(provider)) throw oauthProviderUnknown(segment, supported);
  return provider;
}

function originFor(request: Request, options: OAuthLoginOptions): string {
  const env = options.env ?? Bun.env;
  const declared = options.baseUrl ?? env['APP_URL']?.trim() ?? '';
  return declared === '' ? new URL(request.url).origin : declared.replace(/\/+$/, '');
}

/** The handshake's own options, assembled once so both legs seal and open it identically. */
const sealOptions = (
  clock: Clock,
  options: OAuthLoginOptions,
): { clock: Clock; secret?: string | undefined } => ({
  clock,
  ...(options.secret === undefined ? {} : { secret: options.secret }),
});

async function startHandler(
  auth: Auth,
  options: OAuthLoginOptions,
  request: Request,
): Promise<Response> {
  try {
    const provider = assertEnabled(auth, providerSegment(request, 'start'));
    const credentials = options.credentials ?? oauthCredentials(provider, options.env ?? Bun.env);
    const handshake = beginOAuth({
      provider,
      clientId: credentials.clientId,
      redirectUri: `${originFor(request, options)}${oauthCallbackPath(provider)}`,
      scopes: options.scopes,
    });
    return new Response(null, {
      // 302, the status every OAuth client already expects on this hop.
      status: 302,
      headers: {
        location: handshake.authorizeUrl,
        'set-cookie': handshakeCookie(handshake, sealOptions(auth.clock, options)),
      },
    });
  } catch (error) {
    return problem(error, []);
  }
}

/** The provider declining is `error=` on the redirect, and there is no code to exchange. */
function assertNoProviderError(url: URL, provider: string): void {
  const declined = url.searchParams.get('error');
  if (declined === null || declined === '') return;
  throw oauthDenied(provider, declined, url.searchParams.get('error_description'));
}

async function callbackHandler(
  auth: Auth,
  options: OAuthLoginOptions,
  request: Request,
): Promise<Response> {
  const segment = providerSegment(request, 'callback');
  // Cleared on every outcome, success and failure alike: the code it authorised is spent either
  // way, so a handshake that outlives its own callback is a replay window and nothing else.
  const clear = hasOAuthProvider(segment) ? [clearHandshakeCookie(segment)] : [];
  try {
    const provider = assertEnabled(auth, segment);
    const url = new URL(request.url);
    assertNoProviderError(url, provider);
    const result: LoginResult = await completeOAuthLogin(auth, {
      handshake: readHandshakeCookie(request, provider, sealOptions(auth.clock, options)),
      callback: {
        state: url.searchParams.get('state') ?? '',
        code: url.searchParams.get('code') ?? '',
      },
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.resolveGrants === undefined ? {} : { resolveGrants: options.resolveGrants }),
      ip: options.clientIp?.(request) ?? null,
      userAgent: request.headers.get('user-agent'),
    });
    const headers = new Headers({
      // A fixed path, never `?next=`: an attacker-supplied return target on the one endpoint whose
      // job is to hand out a session is the classic open redirect, and `@ultimat3/http`'s
      // `nextAfterSignIn` is the one implementation of that check. Two copies is one that drifts.
      location: options.successPath ?? '/',
    });
    // 303: the callback may arrive as a `form_post`, and the destination is a GET either way.
    headers.append('set-cookie', result.cookie);
    for (const cookie of clear) headers.append('set-cookie', cookie);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return problem(error, clear);
  }
}

/**
 * The two routes. Mount them and "log in with GitHub" is a button pointing at
 * `/auth/oauth/github` — no handshake store, no PKCE bookkeeping, no state check to forget.
 *
 * ```ts
 * const { start, callback } = oauthLogin(auth);
 * // start.path    → '/auth/oauth/:provider'
 * // callback.path → '/auth/oauth/:provider/callback'
 * ```
 */
export function oauthLogin(auth: Auth, options: OAuthLoginOptions = {}): OAuthLoginRoutes {
  return Object.freeze({
    start: Object.freeze({
      method: 'GET',
      path: OAUTH_START_ROUTE_PATH,
      name: 'auth.oauth.start',
      auth: 'public',
      handle: (request: Request) => startHandler(auth, options, request),
    } as const),
    callback: Object.freeze({
      method: 'GET',
      path: OAUTH_CALLBACK_ROUTE_PATH,
      name: 'auth.oauth.callback',
      auth: 'public',
      handle: (request: Request) => callbackHandler(auth, options, request),
    } as const),
  });
}
