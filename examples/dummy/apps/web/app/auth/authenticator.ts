/**
 * Who a request is: the session its cookie names, as the Postly member that session belongs to —
 * the one authenticator this app installs, in every environment. Everything downstream (a page,
 * a policy, a live subscriber, an MCP tool) reads the actor this returns, and nothing anywhere asks
 * the database a second time who the viewer is.
 */

import { seatLimit } from '@postly/domain';
import { type Auth, authenticate } from '@ultimat3/auth';
import { type Actor, isSessionRefusal, logger, tryResolveEnvironment } from '@ultimat3/core';
import { configureAuthenticator } from '@ultimat3/http';
import { postlyActor } from '../../shared/actor';
import { sessionMember } from '../orgs/repo';
import { DEFAULT_DEMO_MEMBER, DEMO_MEMBER_COOKIE, demoAuthenticate } from './demo-actor';
import { auth as postlyAuth } from './login';

/** The two methods this reads off a request — `UltimateRequest`'s, and a test's plain object. */
export interface SessionRequest {
  cookie(name: string): string | null;
  header(name: string): string | null;
}

export interface SessionAuthenticatorOptions {
  /** The app's `Auth`, asked per request so a test can hand in its own. */
  readonly auth: () => Auth;
  /** Whether a request with NO session cookie is the demo viewer (`./demo-actor.ts`) or nobody. */
  readonly development: boolean;
}

/**
 * A session cookie is that session's member, or nobody — never a fallback to anyone else, in
 * development too. A session past its expiry, or unknown, revoked or forged, is a refusal
 * `authenticate()` THROWS (`isSessionRefusal`: `X_SESSION_EXPIRED`, `X_UNAUTHENTICATED`), answered
 * `null`: a stale cookie is an anonymous visitor, so sign-in still opens and a live socket it opened
 * is closed. Anything else it throws (a session store that is down) propagates. An identity no org has seated (a first GitHub sign-in nobody invited) is that
 * identity with the grants `x_users` holds, which are none: every `can()` denies it by name.
 *
 * The role is the MEMBER's, as `postlyActor` reads it — the membership column is the grant. Postly
 * enrols no second factor; an app that does must keep `authenticate()`'s roles for a session whose
 * factor is still pending, which this replaces.
 */
export const sessionAuthenticator =
  (options: SessionAuthenticatorOptions) =>
  async (request: SessionRequest): Promise<Actor | null> => {
    const auth = options.auth();
    const token = request.cookie(auth.sessions.policy.cookieName);
    if (token === null || token === '') {
      return options.development ? demoAuthenticate(request.header('cookie')) : null;
    }
    const identity = await authenticate(auth, token).catch((error: unknown) => {
      if (isSessionRefusal(error)) return null;
      throw error;
    });
    // The demo fallback is "no cookie at all", above — a refused cookie never reaches it.
    if (identity === null) return null;
    const seated = await sessionMember(identity.id);
    if (seated === null) return identity;
    const { member, org, seatsUsed } = seated;
    // `seats` is the plan's, never a column — the derivation `ctx.orgs.byId` performs.
    return postlyActor({ member, org: { ...org, seats: seatLimit(org.planCode), seatsUsed } });
  };

/**
 * Installs it, and answers whether the demo fallback is on. Fails CLOSED: `fallback: 'production'`,
 * so a process naming neither `ULTIMATE_ENV` nor `NODE_ENV` never answers as the seed's owner —
 * `x dev` and the e2e harness both declare `ULTIMATE_ENV=development`, and `bun test` is `test`,
 * where every fixture mints its own actor.
 */
export function installAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  auth: () => Auth = () => postlyAuth,
): boolean {
  const development = tryResolveEnvironment({ env, fallback: 'production' }) === 'development';
  configureAuthenticator(sessionAuthenticator({ auth, development }));
  if (development) {
    logger.warn('a request with no session is answered as a declared demo viewer', {
      member: DEFAULT_DEMO_MEMBER,
      cause:
        'apps/web/app/auth/authenticator.ts falls back to demo-actor.ts in development, where no sign-in provider is configured',
      fix: `look as someone else: document.cookie = '${DEMO_MEMBER_COOKIE}=mara'   # or sign in at /auth/sso/github`,
    });
  }
  return development;
}

// Module scope, which IS the wiring: the boot scan imports every module under `apps/*` before a
// listener binds, and `x dev` and the container both read the configured value back at start.
installAuthenticator();
