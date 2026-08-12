// contract — the whole authorization chain, driven over HTTP: POST the sign-in form, take the
// `Set-Cookie` off the response, present it, and read a gated page back.
//
// It runs the REAL pipeline — the app's own action routes and page routes, `devHooks()`, and
// `@ultimat3/http`'s stage list — because every bug this file exists to catch was a green unit test
// over code with no caller. `viewerFor` was correct and unreachable, `configureAuthenticator` was
// exported and never called, `member` was granted nothing. Asserting a resolver in isolation
// proves the resolver; only a request proves it is wired.

import { resolve } from 'node:path';
import { seedDemo } from '@social-media-clone/db';
import { listActions, toRoute } from '@ultimat3/action';
import { appRoutes, devHooks, loadApp } from '@ultimat3/cli';
import type { Pipeline } from '@ultimat3/http';
import {
  configuredAuthenticator,
  createPipeline,
  createRouter,
  defineHttpConfig,
} from '@ultimat3/http';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';

const ROOT = resolve(import.meta.dir, '../../../..');
const ORIGIN = 'http://app.test';

/** The gated pages a signed-in demo user lands on. Every one of them 500'd or 403'd. */
const GATED = ['/dashboard', '/friends', '/messages', '/notifications'] as const;

let pipeline: Pipeline;

const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await pipeline.handle(new Request(`${ORIGIN}${path}`, init), { role: 'web' });

/** The cookie a browser would keep, in the form it would send back. */
const cookieOf = (response: Response): string => {
  const header = response.headers.get('set-cookie');
  expect(header).not.toBeNull();
  return (header ?? '').split(';')[0] ?? '';
};

const signIn = async (handle: string, password: string): Promise<string> => {
  const response = await call('/api/sessions/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, password }),
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
};

beforeAll(async () => {
  await seedDemo();
  // The app's own boot: this is what calls `configureAuthenticator()`, declares every permission
  // and defines every role. Nothing below reaches into the app to wire anything by hand — a test
  // that wired the authenticator itself would pass with production still unwired.
  await loadApp(ROOT);
  pipeline = createPipeline({
    table: createRouter([...listActions().map(toRoute), ...appRoutes({ buildId: 'test' })]),
    hooks: devHooks(),
    config: defineHttpConfig({ signInPath: '/signin', buildId: 'test' }),
  });
});

contractTest('the app configured an authenticator — without it every request is anonymous', () => {
  // The condition, not the consequence. `hooks.authenticate` absent is a server where a valid
  // cookie means nothing, and every assertion below would fail with a misleading 401.
  expect(configuredAuthenticator()).toBeDefined();
});

contractTest('a signed-in member reaches every gated page, cookie only', async () => {
  const cookie = await signIn('user', 'user');
  for (const path of GATED) {
    const response = await call(path, { headers: { cookie, accept: 'text/html' } });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    // A gated page must never be shared-cacheable, whatever its route said.
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
});

contractTest('the same pages refuse a BROWSER with no cookie, by redirect', async () => {
  for (const path of GATED) {
    const response = await call(path, { headers: { accept: 'text/html' } });
    expect({ path, status: response.status }).toEqual({ path, status: 303 });
    // `?next=` is the round trip: the sign-in page sends the browser back where it was going.
    expect(response.headers.get('location')).toContain(`/signin?next=${encodeURIComponent(path)}`);
  }
});

contractTest('the same pages refuse an AGENT with no cookie, by problem document', async () => {
  for (const path of GATED) {
    const response = await call(path, { headers: { accept: 'application/json' } });
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as { readonly code?: string };
    expect(body.code).toBe('X_UNAUTHENTICATED');
  }
});

contractTest('a cookie nobody issued is refused exactly like no cookie at all', async () => {
  const response = await call('/friends', {
    headers: { cookie: 'smc_session=not-a-token-anybody-minted', accept: 'application/json' },
  });
  expect(response.status).toBe(401);
});

contractTest('signing out revokes the row, and the SAME cookie stops working', async () => {
  const cookie = await signIn('user', 'user');
  expect((await call('/friends', { headers: { cookie, accept: 'text/html' } })).status).toBe(200);

  const out = await call('/api/sessions/destroy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ confirm: 'sign-out' }),
  });
  expect(out.status).toBe(200);
  // Not decoration: `revoked: false` was the honest report of a sign-out that could not read the
  // cookie it was meant to revoke, and the row outlived the browser that forgot it.
  expect(await out.json()).toMatchObject({ ok: true, revoked: true });

  const after = await call('/friends', { headers: { cookie, accept: 'application/json' } });
  expect(after.status).toBe(401);
});

/**
 * Every auth action is submitted by a NATIVE form — nothing on `site/` hydrates — so every one of
 * them must answer a browser with a redirect and an agent with the output schema.
 *
 * The table is the point. `createSession` and `createAccount` got the split and `destroySession`
 * did not, so signing out really revoked the session and then left the reader looking at
 * `{"ok":true,"next":"/","revoked":true}` in the viewport. A per-action decision is a decision
 * somebody forgets; asserting all three together is what makes forgetting the fourth impossible.
 */
const FORM_POSTS = [
  { path: '/api/sessions/create', body: 'handle=user&password=user', lands: '/feed' },
  {
    path: '/api/accounts/create',
    body: 'handle=freshone&displayName=Fresh+One&email=fresh%40demo.test&password=hunter2hunter2',
    lands: '/feed',
  },
  { path: '/api/sessions/destroy', body: 'confirm=sign-out', lands: '/' },
] as const;

for (const form of FORM_POSTS) {
  contractTest(`${form.path} redirects a browser instead of printing JSON at it`, async () => {
    const response = await call(form.path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: form.body,
    });
    expect({ path: form.path, status: response.status }).toEqual({
      path: form.path,
      status: 303,
    });
    expect(response.headers.get('location')).toBe(form.lands);
  });
}

contractTest('an agent still gets the output schema from every one of them', async () => {
  for (const form of FORM_POSTS) {
    const response = await call(form.path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.body.replace('freshone', 'freshtwo').replace('fresh%40', 'fresh2%40'),
    });
    expect({ path: form.path, status: response.status }).toEqual({
      path: form.path,
      status: 200,
    });
    expect(response.headers.get('content-type')).toContain('application/json');
  }
});
