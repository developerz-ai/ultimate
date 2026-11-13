// The real path and its one fallback: a session cookie is its user in every environment, a bad
// one is refused rather than replaced, and only development answers a request with no session.
import { defineAuth, login, logout, memoryAuthAdapter, register } from '@ultimat3/auth';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { installAuthenticator, sessionAuthenticator } from './authenticator';
import { DEFAULT_DEV_ROLE, DEV_ROLE_COOKIE } from './dev-actor';

/** In memory: the session half is the package's, and this test is about the wiring around it. */
const memoryAuth = () => {
  const auth = defineAuth({ adapter: memoryAuthAdapter() });
  return () => auth;
};

/** A request carrying exactly these cookies, through both methods the authenticator reads. */
const requestWith = (cookies: Readonly<Record<string, string>>) => ({
  header: (name: string) =>
    name === 'cookie' && Object.keys(cookies).length > 0
      ? Object.entries(cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ')
      : null,
  cookie: (name: string) => cookies[name] ?? null,
});

const PASSWORD = 'a long scaffold test passphrase';

unitTest('a session cookie is the user it was issued to, in every environment', async () => {
  const auth = memoryAuth();
  const user = await register(auth(), {
    email: 'ada@example.com',
    password: PASSWORD,
    orgId: DEMO_ORG_ID,
    roles: ['member'],
  });
  const { token } = await login(auth(), { email: 'ada@example.com', password: PASSWORD });
  const request = requestWith({ [auth().sessions.policy.cookieName]: token });
  for (const development of [true, false]) {
    const actor = await sessionAuthenticator({ auth, development })(request);
    expect(actor?.id).toBe(user.id);
    expect(actor?.roles).toEqual(['member']);
  }
});

unitTest('a cookie naming no live session is nobody, never answered as the viewer', async () => {
  const auth = memoryAuth();
  const request = requestWith({ [auth().sessions.policy.cookieName]: 'forged.token' });
  // `null`, not a throw: thrown, a stale cookie was a 401 on the sign-in page itself.
  expect(await sessionAuthenticator({ auth, development: true })(request)).toBeNull();
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
  const request = requestWith({ [auth().sessions.policy.cookieName]: token });
  for (const development of [true, false]) {
    expect(await sessionAuthenticator({ auth, development })(request)).toBeNull();
  }
});

unitTest('no session: the development viewer under x dev, anonymous anywhere else', async () => {
  const auth = memoryAuth();
  const member = requestWith({ [DEV_ROLE_COOKIE]: 'member' });
  expect((await sessionAuthenticator({ auth, development: true })(member))?.roles).toEqual([
    'member',
  ]);
  const none = requestWith({});
  expect((await sessionAuthenticator({ auth, development: true })(none))?.roles).toEqual([
    DEFAULT_DEV_ROLE,
  ]);
  expect(await sessionAuthenticator({ auth, development: false })(member)).toBeNull();
});

unitTest('it installs in every environment; only development turns the fallback on', () => {
  const auth = memoryAuth();
  try {
    expect(installAuthenticator({ ULTIMATE_ENV: 'production' }, auth)).toBe(false);
    expect(configuredAuthenticator()).toBeDefined();
    expect(installAuthenticator({ ULTIMATE_ENV: 'staging' }, auth)).toBe(false);
    // FAILS CLOSED: a process naming NEITHER key is production here, never the default-development
    // a bare `tryResolveEnvironment({ env })` would answer. `x dev` declares
    // `ULTIMATE_ENV=development` before this module loads, for exactly the process this simulates.
    expect(installAuthenticator({}, auth)).toBe(false);
    expect(installAuthenticator({ ULTIMATE_ENV: 'development' }, auth)).toBe(true);
  } finally {
    // Process-global, so the case that installed one takes it back out.
    resetAuthenticator();
  }
});
