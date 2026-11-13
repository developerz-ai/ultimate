// Who a request is: the session its cookie names, resolved by `@ultimat3/auth` — the one
// authenticator this app installs, in every environment. Everything downstream (pages, policies,
// live subscribers, MCP tools) reads the actor this returns.
//
// With NO session cookie the request is anonymous — except under `x dev`, where it is the
// development viewer (`dev-actor.ts`), so a fresh app opens its own dashboard with nothing
// configured. That fallback FAILS CLOSED (`fallback: 'production'`): `tryResolveEnvironment`'s own
// default is `development`, so a process naming NEITHER `ULTIMATE_ENV` nor `NODE_ENV` would
// otherwise read as development too. `x dev` declares `ULTIMATE_ENV=development` for exactly this
// reason, and `bun test` sets `NODE_ENV=test`, where a fixture mints its own actor.
import { type Auth, authenticate } from '@ultimat3/auth';
import { type Actor, isSessionRefusal, logger, tryResolveEnvironment } from '@ultimat3/core';
import { configureAuthenticator } from '@ultimat3/http';
import { appAuth } from './auth';
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_COOKIE,
  devAuthenticate,
  type HeaderRequest,
} from './dev-actor';

/** The two methods this reads off a request. */
export interface SessionRequest extends HeaderRequest {
  cookie(name: string): string | null;
}

export interface SessionAuthenticatorOptions {
  /** The app's `Auth`, asked for per request so it is built after the boot, not at import. */
  readonly auth: () => Auth;
  /** Whether a request with no session is the development viewer rather than anonymous. */
  readonly development: boolean;
}

/**
 * A session cookie is that session's user, or nobody — never a fallback to anyone else. A session
 * past its expiry, or one unknown, revoked or forged, or whose user is disabled, is a refusal
 * `authenticate()` THROWS (`isSessionRefusal`: `X_SESSION_EXPIRED`, `X_UNAUTHENTICATED`), and it
 * is answered `null`: a stale cookie is an anonymous visitor, so sign-in still opens and a live
 * socket it opened is closed. Anything else it throws — a session store that is down — is not an
 * answer about this visitor and propagates. No cookie is the development viewer or nobody.
 */
export const sessionAuthenticator =
  (options: SessionAuthenticatorOptions) =>
  async (request: SessionRequest): Promise<Actor | null> => {
    const auth = options.auth();
    const token = request.cookie(auth.sessions.policy.cookieName);
    if (token === null || token.length === 0) {
      return options.development ? devAuthenticate(request) : null;
    }
    try {
      return await authenticate(auth, token);
    } catch (error) {
      if (isSessionRefusal(error)) return null;
      throw error;
    }
  };

/**
 * Installs the session authenticator, and returns whether the development fallback is on — so the
 * test can assert both halves. Loud when it is, because a stand-in for a session is the one thing
 * an operator must never find in a log they did not expect it in.
 */
export function installAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  auth: () => Auth = appAuth,
): boolean {
  const development = tryResolveEnvironment({ env, fallback: 'production' }) === 'development';
  configureAuthenticator(sessionAuthenticator({ auth, development }));
  if (development) {
    logger.warn('a request with no session is answered as a development viewer', {
      role: DEFAULT_DEV_ROLE,
      cause:
        'apps/web/app/auth/authenticator.ts falls back to dev-actor.ts in development, because this app has no sign-in page yet',
      fix: `browse as someone else: document.cookie = '${DEV_ROLE_COOKIE}=member'`,
    });
  }
  return development;
}

// Module scope, which IS the wiring: the boot scan imports every module under `apps/*` before a
// listener binds, and `x dev` and the container both read the configured value back at start.
installAuthenticator();
