// `endSession`, run inside a real request context: what it writes onto the response the pipeline
// assembles — the session cookie expired, and the demo viewer's switch, script-settable by design.

import { createSession, memoryAuthAdapter } from '@ultimat3/auth';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { asCtx, defineHttpConfig, requestContext } from '@ultimat3/http';
import { describe, expect, test } from '@ultimat3/testing';
import { AFTER_SIGN_OUT, endSession } from './actions/end-session';
import { sessionAuthenticator } from './authenticator';
import { DEMO_MEMBER_COOKIE, DEMO_SIGNED_OUT } from './demo-actor';
import { auth } from './login';

const signOut = async (accept: string, cookie?: string) => {
  const url = new URL(`https://postly.test/api/sessions/end`);
  const config = defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } });
  const request = requestContext({
    url,
    method: 'POST',
    role: 'web',
    config,
    requestHeaders: { accept, ...(cookie === undefined ? {} : { cookie }) },
  });
  const ctx = asCtx(request);
  const output = await runWithContext(ctx, () => endSession({}, { ctx }));
  return { output, request };
};

describe('ending the demo session', () => {
  test('sets the demo cookie to signed-out, and a page can still set it back', async () => {
    const { output, request } = await signOut('application/json');

    expect(output).toEqual({ ok: true, next: AFTER_SIGN_OUT });
    const cookie = request.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${DEMO_MEMBER_COOKIE}=`));
    expect(cookie).toStartWith(`${DEMO_MEMBER_COOKIE}=${DEMO_SIGNED_OUT};`);
    // NOT HttpOnly: `authenticator.ts`'s boot line tells a developer to switch member with
    // `document.cookie = '…'`, and a script write cannot overwrite an HttpOnly cookie — after one
    // sign-out that instruction would silently do nothing.
    expect(cookie?.toLowerCase()).not.toContain('httponly');
    // Nor Secure: a script on `http://localhost` cannot overwrite a Secure cookie either.
    expect(cookie?.toLowerCase()).not.toContain('secure');
    expect(cookie).toContain('Path=/');
    // And the browser drops the previous member's storage and cached pages.
    expect(request.headers.get('clear-site-data')).not.toBeNull();
  });

  test('a native form post is sent home; an agent gets the JSON and no redirect', async () => {
    expect((await signOut('text/html')).request.redirect).toBeDefined();
    expect((await signOut('application/json')).request.redirect).toBeUndefined();
  });

  test('expires the session cookie a sign-in set, whatever its token', async () => {
    const name = auth.sessions.policy.cookieName;
    // Not a session's shape, so the server-side revoke answers `false` before any store is asked
    // (a unit test has no database) — and the browser's copy goes anyway.
    const { output, request } = await signOut('application/json', `${name}=not-a-session`);

    expect(output.ok).toBe(true);
    const expired = request.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
    expect(expired).toBeDefined();
    expect(expired?.toLowerCase()).toContain('max-age=0');
  });

  /**
   * The app's `auth` is Postgres and a unit test has none, so its session reads are pointed at one
   * memory store for this test and handed back after: the action, the authenticator and the token
   * are the real ones, only the rows live in RAM.
   */
  test('signs out twice with the same cookie: the second is a no-op, never a refusal', async () => {
    const name = auth.sessions.policy.cookieName;
    const memory = memoryAuthAdapter();
    const reads = ['getSession', 'getSessionWithUser', 'deleteSession', 'findUserById'] as const;
    const saved = Object.fromEntries(reads.map((key) => [key, auth.adapter[key]]));
    Object.assign(
      auth.adapter,
      Object.fromEntries(reads.map((key) => [key, memory[key].bind(memory)])),
    );
    try {
      const userId = '00000000-0000-4000-8000-00000000e0a1';
      await memory.createUser({
        id: userId,
        email: 'ines@acme.example',
        passwordHash: null,
        orgId: null,
        roles: [],
        createdAt: new Date(0),
      });
      const { token } = await createSession({ ...auth.sessions, store: memory }, { userId });
      const cookie = `${name}=${token}`;
      const request = { cookie: () => token, header: () => cookie };
      const authenticate = sessionAuthenticator({ auth: () => auth, development: false });
      // What the pipeline's auth stage runs inside: a request with nobody resolved yet.
      const anyone = () => runWithContext(ctxOf({}), () => authenticate(request));
      expect((await anyone())?.id).toBe(userId);

      for (const attempt of [1, 2]) {
        const { output, request: sent } = await signOut('application/json', cookie);
        expect({ attempt, ok: output.ok }).toEqual({ attempt, ok: true });
        const expired = sent.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
        expect(expired?.toLowerCase()).toContain('max-age=0');
        // Revoked by the first: before the second runs, the pipeline's authenticator reads the
        // stale cookie as nobody rather than a 401, so the sign-out still opens (#1119).
        expect(await anyone()).toBeNull();
      }
    } finally {
      Object.assign(auth.adapter, saved);
    }
  });
});
