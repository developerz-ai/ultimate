// An action that issues a session sets its cookie with `setCookie(sessionCookie(…))`. Proven over a
// real socket with the real auth package: what the browser is sent is what `verifySession` accepts
// on the way back, and the token never rides in the action's answer.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  createSession,
  defineAuth,
  memoryAuthAdapter,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from '@ultimat3/auth';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig, httpServer, setCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';

const USER_ID = 'user_operator_7';
const auth = defineAuth({ adapter: memoryAuthAdapter() });
const Answer = t.object({ userId: t.string });

const issueSession = action({
  input: t.object({}),
  output: Answer,
  policy: allow('issue-session'),
  async handle() {
    const issued = await createSession(auth.sessions, { userId: USER_ID });
    setCookie(sessionCookie(issued.token, auth.sessions.policy));
    setCookie('theme', 'dark');
    return { userId: issued.session.userId };
  },
}).named('issueSession');

const smuggleHeader = action({
  input: t.object({}),
  output: Answer,
  policy: allow('smuggle-header'),
  handle() {
    setCookie('sid=v; Path=/; HttpOnly; Secure; SameSite=Lax\r\nX-Evil: 1');
    return { userId: USER_ID };
  },
}).named('smuggleHeader');

const issueRoute = toRoute(issueSession);
const smuggleRoute = toRoute(smuggleHeader);

resetLifecycle();
const handle = httpServer({
  routes: [issueRoute, smuggleRoute],
  role: 'web',
  config: defineHttpConfig({
    rateLimit: { scope: 'process' },
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
  }),
}).start();

afterAll(async () => {
  await handle.stop();
  resetLifecycle();
});

const post = (path: string): Promise<Response> =>
  fetch(`${handle.url()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: handle.url() },
    body: '{}',
  });

describe('an action issuing a session, over a real socket', () => {
  test('the browser gets the session cookie, and it verifies on the way back', async () => {
    const response = await post(issueRoute.path);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ userId: USER_ID });

    const [session = '', theme = ''] = response.headers.getSetCookie();
    const { cookieName, absoluteTtlMs } = auth.sessions.policy;
    expect(session.startsWith(`${cookieName}=`)).toBe(true);
    expect(session).toEndWith(
      `; Max-Age=${absoluteTtlMs / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(theme).toStartWith('theme=dark;');

    const returning = new Request(handle.url(), {
      headers: { cookie: session.slice(0, session.indexOf(';')) },
    });
    const token = readSessionCookie(returning, auth.sessions.policy) ?? '';
    expect((await verifySession(auth.sessions, token)).userId).toBe(USER_ID);
    expect(body).not.toContain(token);
  });

  test('a line carrying a second header is refused, and neither header is sent', async () => {
    const response = await post(smuggleRoute.path);
    const problem = (await response.json()) as { readonly code?: string };
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(problem.code).toBe('X_COOKIE_INVALID');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('x-evil')).toBeNull();
  });
});
