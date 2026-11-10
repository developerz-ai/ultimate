// Single responsibility: the ONE implementation of the two sign-in legs over any `IdentityProvider`
// — start (`begin`, seal the state, 302) and callback (open it, `complete`, `signInWithIdentity`,
// 303; coded JSON on refusal). `identityProviderRoutes` and `oauthLogin` are this function with two
// policies, so the state cookie, the refusal body and the redirect rules cannot drift apart.

import {
  EnvMissingError,
  isUltimateError,
  logger,
  renderFixShellArg,
  type UltimateError,
} from '@ultimat3/core';
import type { Auth } from './auth';
import {
  type IdentityProvider,
  signInWithIdentity,
  type VerifiedIdentity,
} from './identity-provider';
import {
  clearIdentityStateCookie,
  identityStateCookie,
  readIdentityState,
} from './identity-provider-cookie';
import { oauthRouteStatus } from './identity-provider-status';
import { oauthStateInvalid } from './oauth-errors';
import type { OAuthGrants } from './oauth-login';
import {
  OAUTH_CALLBACK_ROUTE_PATH,
  OAUTH_START_ROUTE_PATH,
  oauthCallbackPath,
} from './oauth-paths';
import { samlResponseInvalid } from './saml-errors';

export interface SignInRouteDescriptor {
  readonly method: 'GET' | 'POST';
  /** The mount pattern, `:provider` included. The handler re-reads it off the request itself. */
  readonly path: string;
  readonly name: string;
  /** Both legs are public by definition — they are how an anonymous visitor stops being one. */
  readonly auth: 'public';
  /** What a router mounts as the route's `meta`, verbatim: `meta: leg.meta`. */
  readonly meta: SignInRouteMeta;
  handle(request: Request): Promise<Response>;
}

/**
 * The route meta, structurally `@ultimat3/http`'s (`Route['meta']`): this package is its tier and
 * cannot import it. The POST leg — SAML's ACS — is `csrf: 'cookieless'` with its own
 * `authenticate: () => null`: the IdP answers with an auto-submitted CROSS-SITE form, which the csrf
 * stage refuses on any other route. CSRF is still defended there, by the protocol: the answer must
 * carry this browser's RelayState (`answers()`, timing-safe against the HMAC-sealed state cookie)
 * and its assertion must name this request's ID as InResponseTo — an attacker's form has neither.
 * And no session cookie decides anything on it.
 */
export interface SignInRouteMeta {
  readonly name: string;
  readonly auth: 'public';
  // No `| undefined`: http's `Route['meta']` takes these absent or set, never `undefined`.
  readonly csrf?: 'cookieless';
  readonly authenticate?: () => null;
}

/** What both front doors accept. */
export interface SignInRouteOptions {
  /** The origin the IdP answers to. Defaults to `APP_URL`; never the request's `Host`. */
  readonly baseUrl?: string | undefined;
  /** Defaults to `SESSION_SECRET`. Seals the state across the two requests. */
  readonly secret?: string | undefined;
  /** A fixed landing path, never `?next=`: `nextAfterSignIn` in `@ultimat3/http` is the one check. */
  readonly successPath?: string | undefined;
  /** The client address recorded on the session; `@ultimat3/http` knows the proxy chain. */
  readonly clientIp?: ((request: Request) => string | null | undefined) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** What differs between the two front doors. */
export interface SignInRoutePolicy {
  /** The provider a URL segment names and this app enabled, or `unknown(segment)` for both. */
  resolve(segment: string, leg: 'start' | 'callback'): IdentityProvider;
  /** The one 404: unknown, not enabled, or answered by the wrong method — never told apart. */
  unknown(segment: string): UltimateError;
  /** `auth.sso` / `auth.oauth`: the log event prefix (`<prefix>.refused`). */
  readonly event: string;
  readonly names: { readonly start: string; readonly callback: string; readonly acs: string };
  /** A throw with no code, logged and turned into the refusal served. Its text never is. */
  uncoded(error: unknown): UltimateError;
  grants(identity: VerifiedIdentity): Promise<OAuthGrants | undefined> | OAuthGrants | undefined;
}

export interface SignInRoutes {
  readonly start: SignInRouteDescriptor;
  /** OIDC's redirect back. */
  readonly callback: SignInRouteDescriptor;
  /** SAML's Assertion Consumer Service: the same path, POSTed. */
  readonly acs: SignInRouteDescriptor;
}

const MAX_FORM_BYTES = 512 * 1024;
const FRAMEWORK_CODE = /^X_[A-Z0-9_]+$/;

function problem(policy: SignInRoutePolicy, error: unknown, cookies: readonly string[]): Response {
  const refusal = isUltimateError(error) ? error : policy.uncoded(error);
  const status = oauthRouteStatus(refusal.code);
  const fields = { code: refusal.code, status, cause: refusal.cause, fix: refusal.fix };
  if (status >= 500) logger.error(`${policy.event}.refused`, fields);
  else logger.info(`${policy.event}.refused`, fields);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  // An anonymous caller reads the code, its title and docs, and one fixed sentence; the authored
  // cause and fix name env vars and what an IdP answered, so they go to the log only.
  const body = {
    code: refusal.code,
    title: refusal.title,
    cause: `the sign-in was refused; its cause and its fix are in this server’s log under ${policy.event}.refused`,
    fix: FRAMEWORK_CODE.test(refusal.code)
      ? `x errors explain ${renderFixShellArg(refusal.code, '<CODE>')} --json`
      : 'x errors list --json',
    docs: refusal.docs,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function segmentOf(request: Request, leg: 'start' | 'callback'): string {
  const parts = new URL(request.url).pathname.split('/').filter((part) => part !== '');
  return parts[leg === 'start' ? parts.length - 1 : parts.length - 2] ?? '';
}

function origin(options: SignInRouteOptions): string {
  const declared = (options.baseUrl ?? (options.env ?? Bun.env)['APP_URL'] ?? '').trim();
  if (declared === '') {
    throw new EnvMissingError({
      cause:
        'APP_URL is not set and the sign-in routes were given no baseUrl, so there is no declared origin to build the IdP callback URL from',
      fix: 'export APP_URL=http://localhost:3000   # the origin this app is served from',
      meta: { key: 'APP_URL' },
    });
  }
  return declared.replace(/\/+$/, '');
}

/**
 * The form body, never more than `MAX_FORM_BYTES` of it: a declared length over the cap refuses
 * before one byte is read, and an undeclared or lying one is cut off at the cap as it streams.
 */
async function formParams(request: Request, provider: string): Promise<Record<string, string>> {
  const tooLarge = () => samlResponseInvalid(provider, 'encoding', 'the posted form is too large');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_FORM_BYTES) throw tooLarge();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const next = await reader?.read();
    if (next === undefined || next.done) break;
    size += next.value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader?.cancel();
      throw tooLarge();
    }
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return Object.fromEntries(new URLSearchParams(text));
}

export function signInRoutes(
  auth: Auth,
  options: SignInRouteOptions,
  policy: SignInRoutePolicy,
): SignInRoutes {
  const seal = {
    clock: auth.clock,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  };

  const start = async (request: Request): Promise<Response> => {
    try {
      // Before the provider: asked after, a missing origin answered 500 for an enabled provider
      // and 404 for one that is not — an oracle for the app's configuration.
      const base = origin(options);
      const provider = policy.resolve(segmentOf(request, 'start'), 'start');
      const callbackUrl = `${base}${oauthCallbackPath(provider.id)}`;
      const redirect = await provider.begin({ callbackUrl, clock: auth.clock });
      const headers = new Headers({ location: redirect.location });
      headers.append('set-cookie', identityStateCookie(provider, redirect.state, seal));
      return new Response(null, { status: 302, headers });
    } catch (error) {
      return problem(policy, error, []);
    }
  };

  const callback = async (request: Request): Promise<Response> => {
    const segment = segmentOf(request, 'callback');
    // Set only once the answer is bound to this browser's state; then cleared on every outcome,
    // since that answer is spent either way. An unbound answer — a junk cross-site POST riding the
    // SameSite=None cookie — clears nothing, so it cannot end a sign-in in flight.
    const clear: string[] = [];
    try {
      const base = origin(options);
      const provider = policy.resolve(segment, 'callback');
      // A provider answers by one method: SAML's POST binding, or OIDC's redirect.
      if (request.method !== provider.callbackMethod) throw policy.unknown(provider.id);
      const params =
        request.method === 'POST'
          ? await formParams(request, provider.id)
          : Object.fromEntries(new URL(request.url).searchParams);
      const state = readIdentityState(request, provider, seal);
      if (!provider.answers(state, params)) {
        throw oauthStateInvalid(provider.id, 'the answer does not carry this browser\u2019s state');
      }
      clear.push(clearIdentityStateCookie(provider.id, provider.callbackMethod));
      const identity = await provider.complete({
        state,
        params,
        callbackUrl: `${base}${oauthCallbackPath(provider.id)}`,
        clock: auth.clock,
        replay: auth.totpReplay,
      });
      const grants = await policy.grants(identity);
      const result = await signInWithIdentity(auth, identity, {
        ...(grants === undefined ? {} : { grants }),
        ip: options.clientIp?.(request) ?? null,
        userAgent: request.headers.get('user-agent'),
      });
      const headers = new Headers({ location: options.successPath ?? '/' });
      headers.append('set-cookie', result.cookie);
      for (const cookie of clear) headers.append('set-cookie', cookie);
      // 303: the answer may arrive as a POST, and the destination is a GET either way.
      return new Response(null, { status: 303, headers });
    } catch (error) {
      return problem(policy, error, clear);
    }
  };

  const route = (
    method: 'GET' | 'POST',
    path: string,
    name: string,
    handle: (request: Request) => Promise<Response>,
  ): SignInRouteDescriptor => {
    const meta: SignInRouteMeta =
      method === 'POST'
        ? { name, auth: 'public', csrf: 'cookieless', authenticate: () => null }
        : { name, auth: 'public' };
    return Object.freeze({ method, path, name, auth: 'public', meta: Object.freeze(meta), handle });
  };
  return Object.freeze({
    start: route('GET', OAUTH_START_ROUTE_PATH, policy.names.start, start),
    callback: route('GET', OAUTH_CALLBACK_ROUTE_PATH, policy.names.callback, callback),
    acs: route('POST', OAUTH_CALLBACK_ROUTE_PATH, policy.names.acs, callback),
  });
}
