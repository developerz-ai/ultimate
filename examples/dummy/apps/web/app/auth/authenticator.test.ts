/**
 * unit — who a request is. A session cookie is the member that session belongs to, with their org,
 * in every environment; a forged, revoked or expired one is nobody; none is the demo viewer under
 * `x dev` and nobody anywhere else. And the module-scope install, which is the wiring: nothing calls it.
 */

import { db, driver } from '@postly/db';
import { createSession, defineAuth, logout, memoryAuthAdapter } from '@ultimat3/auth';
import { type Actor, actorFact, ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { afterEach, describe, expect, test, testStatements } from '@ultimat3/testing';
import { installAuthenticator, type SessionRequest, sessionAuthenticator } from './authenticator';
import { DEMO_MEMBER_COOKIE, DEMO_SIGNED_OUT, DEMO_VIEWERS } from './demo-actor';

const NOW = new Date('2026-11-13T09:00:00.000Z');
const ORG = '00000000-0000-4000-8000-00000000c0a1';
const MEMBER = '00000000-0000-4000-8000-00000000c0b1';

afterEach(() => {
  resetAuthenticator();
  driver.reset?.();
});

/** One `Auth` over memory, and the `x_users` row a member signs in as: same id, as passkeys key it. */
async function signedIn(
  userId: string,
  clock = frozenClock(NOW),
): Promise<{ auth: ReturnType<typeof defineAuth>; token: string }> {
  const auth = defineAuth({ adapter: memoryAuthAdapter(), clock });
  await auth.adapter.createUser({
    id: userId,
    email: 'ines@acme.example',
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: NOW,
  });
  const { token } = await createSession(auth.sessions, { userId });
  return { auth, token };
}

/** The two methods the authenticator reads off a request. */
const requestWith = (cookies: Readonly<Record<string, string>>): SessionRequest => ({
  cookie: (name) => cookies[name] ?? null,
  header: (name) =>
    name === 'cookie'
      ? Object.entries(cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ')
      : null,
});

/** What the pipeline's auth stage runs inside: a request with nobody resolved yet. */
const resolve = (
  authenticate: ReturnType<typeof sessionAuthenticator>,
  request: SessionRequest,
): Promise<Actor | null> => runWithContext(ctxOf({}), () => authenticate(request));

/** A seated member of a stored org — the rows a session resolves to. */
async function seatMember(): Promise<void> {
  await db.orgs.insert({ id: ORG, slug: 'acme-auth', name: 'Acme', planCode: 'team' });
  await db.members.insert({
    id: MEMBER,
    orgId: ORG,
    userId: MEMBER,
    email: 'ines@acme.example',
    name: 'Inés Duarte',
    role: 'author',
    tz: 'Europe/Madrid',
    locale: 'es',
  });
}

describe('a session cookie', () => {
  test('is the member it belongs to, their org and its seats riding as facts', async () => {
    await seatMember();
    const { auth, token } = await signedIn(MEMBER);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: false });

    const actor = await resolve(
      authenticate,
      requestWith({ [auth.sessions.policy.cookieName]: token }),
    );

    expect(actor?.id).toBe(MEMBER);
    expect(actor?.orgId).toBe(ORG);
    expect(actor?.roles).toEqual(['author']);
    expect(actorFact(actor ?? undefined, 'member')?.name).toBe('Inés Duarte');
    expect(actorFact(actor ?? undefined, 'org')).toMatchObject({ slug: 'acme-auth', seatsUsed: 1 });
  });

  test('resolves its member in three reads, whatever the org holds', async () => {
    await seatMember();
    const { auth, token } = await signedIn(MEMBER);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: false });
    let sent = 0;
    {
      using statements = await testStatements();
      await resolve(authenticate, requestWith({ [auth.sessions.policy.cookieName]: token }));
      sent = statements.count();
    }
    // The member, the org, the seat count. The session itself is the auth adapter's, not `db`'s.
    expect(sent).toBe(3);
  });

  test('of an identity that is nobody’s member is that identity, holding no Postly grant', async () => {
    const { auth, token } = await signedIn('00000000-0000-4000-8000-00000000c0ff');
    const authenticate = sessionAuthenticator({ auth: () => auth, development: false });

    const actor = await resolve(
      authenticate,
      requestWith({ [auth.sessions.policy.cookieName]: token }),
    );

    expect(actor?.id).toBe('00000000-0000-4000-8000-00000000c0ff');
    expect(actor?.roles).toEqual([]);
    expect(actorFact(actor ?? undefined, 'member')).toBeUndefined();
  });

  // `null`, never a throw and never the demo viewer: thrown, a stale cookie was a 401 on the
  // sign-in page itself and a live socket the re-auth sweep kept open (#1119).
  test('that is forged is nobody, even in development: never a fallback to the demo viewer', async () => {
    const { auth } = await signedIn(MEMBER);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: true });

    expect(
      await resolve(
        authenticate,
        requestWith({ [auth.sessions.policy.cookieName]: 'forged.token' }),
      ),
    ).toBeNull();
  });

  test('that was signed out is nobody, even in development: never the demo viewer', async () => {
    await seatMember();
    const { auth, token } = await signedIn(MEMBER);
    await logout(auth, token);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: true });

    expect(
      await resolve(authenticate, requestWith({ [auth.sessions.policy.cookieName]: token })),
    ).toBeNull();
  });

  test('past its expiry is nobody', async () => {
    await seatMember();
    const clock = frozenClock(NOW);
    const { auth, token } = await signedIn(MEMBER, clock);
    clock.advance(auth.sessions.policy.absoluteTtlMs + 1);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: true });

    expect(
      await resolve(authenticate, requestWith({ [auth.sessions.policy.cookieName]: token })),
    ).toBeNull();
  });

  test('whose store fails is a failure that propagates, not an anonymous visitor', async () => {
    const { auth, token } = await signedIn(MEMBER);
    // Input to the code under test: a session store that is down, which says nothing about WHO.
    // Both reads `authenticate()` may take: the joined one when the adapter has it, else the session.
    const down = () => Promise.reject(new Error('session store unreachable'));
    Object.assign(auth.adapter, { getSession: down, getSessionWithUser: down });
    const authenticate = sessionAuthenticator({ auth: () => auth, development: true });

    await expect(
      resolve(authenticate, requestWith({ [auth.sessions.policy.cookieName]: token })),
    ).rejects.toThrow('session store unreachable');
  });
});

describe('no session cookie', () => {
  test('is the demo viewer under x dev, and the cookie still switches it', async () => {
    const { auth } = await signedIn(MEMBER);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: true });

    expect((await resolve(authenticate, requestWith({})))?.id).toBe(DEMO_VIEWERS.ada.member.id);
    const mara = await resolve(authenticate, requestWith({ [DEMO_MEMBER_COOKIE]: 'mara' }));
    expect(mara?.id).toBe(DEMO_VIEWERS.mara.member.id);
    expect(
      await resolve(authenticate, requestWith({ [DEMO_MEMBER_COOKIE]: DEMO_SIGNED_OUT })),
    ).toBeNull();
  });

  test('is nobody everywhere else', async () => {
    const { auth } = await signedIn(MEMBER);
    const authenticate = sessionAuthenticator({ auth: () => auth, development: false });

    expect(await resolve(authenticate, requestWith({ [DEMO_MEMBER_COOKIE]: 'mara' }))).toBeNull();
  });
});

describe('the install', () => {
  test('configures the authenticator in every environment, the demo fallback only in development', () => {
    expect(installAuthenticator({ ULTIMATE_ENV: 'development' })).toBe(true);
    expect(configuredAuthenticator()).toBeDefined();
    resetAuthenticator();
    // Fails closed: no ULTIMATE_ENV and no NODE_ENV is production here, never the demo viewer.
    for (const env of [{ ULTIMATE_ENV: 'production' }, { NODE_ENV: 'test' }, {}]) {
      expect(installAuthenticator(env)).toBe(false);
      expect(configuredAuthenticator()).toBeDefined();
      resetAuthenticator();
    }
  });

  /**
   * The module-scope call, which is the whole wiring: `x dev`'s boot scan and the container import
   * every module under `apps/*` and call nothing. This suite is `NODE_ENV=test`, and an install
   * there would be indistinguishable from one a test made, so a child process imports the module.
   */
  test('importing the module installs the hook, with nobody calling anything', async () => {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `await import(${JSON.stringify(`${import.meta.dir}/authenticator.ts`)});
         const { configuredAuthenticator } = await import('@ultimat3/http');
         console.log('VERDICT', configuredAuthenticator() === undefined ? 'none' : 'installed');`,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, NODE_ENV: 'production', ULTIMATE_ENV: 'production' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The child's stack is the only evidence of WHICH module failed to evaluate.
    if (code !== 0) expect.unreachable(`the import exited ${code}:\n${err}`);
    expect(out).toContain('VERDICT installed');
  });
});
