// The authenticator once sign-in exists: a session cookie is its user and no session is nobody, in
// every environment — `x new`'s development viewer (`dev-actor.ts`) and its fallback line are gone,
// because a developer now signs in the way everyone does. `x g sign-in --oidc` swaps it in, and only
// over the files `x new` wrote byte for byte: an author's edit is never overwritten.

import type { GeneratedFile } from './naming';
import { AUTH_DIR } from './sign-in-shared';

const authenticatorSource =
  (): string => `// Who a request is: the session its cookie names, resolved by \`@ultimat3/auth\` — the one
// authenticator this app installs, in every environment. Everything downstream (pages, policies,
// live subscribers, MCP tools) reads the actor this returns. With no session the request is
// anonymous, everywhere: a developer signs in through \`/auth/sign-in\` like everyone else.
import { type Auth, authenticate } from '@ultimat3/auth';
import { type Actor, isSessionRefusal } from '@ultimat3/core';
import { configureAuthenticator } from '@ultimat3/http';
import { appAuth } from './auth';

/** The one method this reads off a request. */
export interface SessionRequest {
  cookie(name: string): string | null;
}

/**
 * A session cookie is that session's user, or nobody — never a fallback to anyone else. A session
 * past its expiry, or one unknown, revoked or forged, is a refusal \`authenticate()\` THROWS
 * (\`isSessionRefusal\`: \`X_SESSION_EXPIRED\`, \`X_UNAUTHENTICATED\`), answered \`null\`: a stale
 * cookie is an anonymous visitor, so sign-in still opens and a live socket it opened is closed.
 * Anything else it throws — a session store that is down — propagates.
 */
export const sessionAuthenticator =
  (auth: () => Auth) =>
  async (request: SessionRequest): Promise<Actor | null> => {
    const resolved = auth();
    const token = request.cookie(resolved.sessions.policy.cookieName);
    if (token === null || token.length === 0) return null;
    try {
      return await authenticate(resolved, token);
    } catch (error) {
      if (isSessionRefusal(error)) return null;
      throw error;
    }
  };

/** Installs the session authenticator. */
export function installAuthenticator(auth: () => Auth = appAuth): void {
  configureAuthenticator(sessionAuthenticator(auth));
}

// Module scope, which IS the wiring: the boot scan imports every module under \`apps/*\` before a
// listener binds, and \`x dev\` and the container both read the configured value back at start.
installAuthenticator();
`;

const authenticatorTest =
  (): string => `// A session cookie is the user it was issued to; a bad, expired or signed-out one is nobody, and
// so is none.
import { defineAuth, login, logout, memoryAuthAdapter, register } from '@ultimat3/auth';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { installAuthenticator, sessionAuthenticator } from './authenticator';

const memoryAuth = () => {
  const auth = defineAuth({ adapter: memoryAuthAdapter() });
  return () => auth;
};

const requestWith = (cookies: Readonly<Record<string, string>>) => ({
  cookie: (name: string) => cookies[name] ?? null,
});

const PASSWORD = 'a long scaffold test passphrase';

unitTest('a session cookie is the user it was issued to', async () => {
  const auth = memoryAuth();
  const user = await register(auth(), {
    email: 'ada@example.com',
    password: PASSWORD,
    orgId: DEMO_ORG_ID,
    roles: ['member'],
  });
  const { token } = await login(auth(), { email: 'ada@example.com', password: PASSWORD });
  const actor = await sessionAuthenticator(auth)(
    requestWith({ [auth().sessions.policy.cookieName]: token }),
  );
  expect(actor?.id).toBe(user.id);
  expect(actor?.roles).toEqual(['member']);
});

unitTest('a forged cookie is nobody, and no cookie is anonymous', async () => {
  const auth = memoryAuth();
  const forged = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });
  // \`null\`, not a throw: thrown, a stale cookie was a 401 on the sign-in page itself.
  expect(await sessionAuthenticator(auth)(forged)).toBeNull();
  expect(await sessionAuthenticator(auth)(requestWith({}))).toBeNull();
});

unitTest('a signed-out cookie is nobody, so its socket is closed on re-check', async () => {
  const auth = memoryAuth();
  await register(auth(), {
    email: 'ada@example.com',
    password: PASSWORD,
    orgId: DEMO_ORG_ID,
    roles: ['member'],
  });
  const { token } = await login(auth(), { email: 'ada@example.com', password: PASSWORD });
  await logout(auth(), token);
  const cookie = requestWith({ [auth().sessions.policy.cookieName]: token });
  expect(await sessionAuthenticator(auth)(cookie)).toBeNull();
});

unitTest('it installs', () => {
  try {
    installAuthenticator(memoryAuth());
    expect(configuredAuthenticator()).toBeDefined();
  } finally {
    resetAuthenticator();
  }
});
`;

/** The two files the swap writes over `x new`'s, when those are still `x new`'s. */
export function signedInAuthenticatorFiles(): readonly GeneratedFile[] {
  return [
    { path: `${AUTH_DIR}/authenticator.ts`, contents: authenticatorSource() },
    { path: `${AUTH_DIR}/authenticator.test.ts`, contents: authenticatorTest() },
  ];
}

/** The development viewer the swap deletes, with the authenticator's fallback that asked it. */
export const DEV_ACTOR_FILES: readonly string[] = [
  `${AUTH_DIR}/dev-actor.ts`,
  `${AUTH_DIR}/dev-actor.test.ts`,
];
