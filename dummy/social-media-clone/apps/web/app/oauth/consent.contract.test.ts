// contract — the consent screen over HTTP, on the app's real pipeline: a signed-in person opens
// what an MCP client's authorization URL points at, sees who is asking, and answers with the
// page's own form — a 303 back to the client carrying a code, or `access_denied`. Signed out, the
// page bounces to sign-in like every gated page, and a request this server cannot answer renders
// a refusal instead of two buttons.

import { resolve } from 'node:path';
import { seedDemo } from '@social-media-clone/db';
import '@social-media-clone/i18n';
import { listActions, toRoute } from '@ultimat3/action';
import { appRoutes, devHooks, loadApp } from '@ultimat3/cli';
import type { Pipeline } from '@ultimat3/http';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';
import { MCP_SCOPE, mcpOAuth } from './server';

const ROOT = resolve(import.meta.dir, '../../../..');
const ORIGIN = 'http://app.test';
const REDIRECT = 'http://127.0.0.1:33418/callback';

let pipeline: Pipeline;

const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await pipeline.handle(new Request(`${ORIGIN}${path}`, init), { role: 'web' });

const signIn = async (): Promise<string> => {
  const response = await call('/api/sessions/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'user', password: 'user' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
};

/** A registered desktop client's authorization request, as the query it sends the browser to. */
const authorizeQuery = async (): Promise<string> => {
  const { client } = await mcpOAuth.registerClient({ name: 'Desktop', redirectUris: [REDIRECT] });
  return new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    scope: MCP_SCOPE,
    state: 'st',
  }).toString();
};

/** The page's own form, posted as a browser posts it: same origin, wanting HTML. */
const decide = (path: string, cookie: string, request: string) =>
  call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      cookie,
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ request }).toString(),
  });

beforeAll(async () => {
  await seedDemo();
  await loadApp(ROOT);
  pipeline = httpPipeline({
    table: httpRouter([...listActions().map(toRoute), ...appRoutes({ buildId: 'test' })]),
    hooks: devHooks(),
    config: defineHttpConfig({
      signInPath: '/signin',
      buildId: 'test',
      rateLimit: { scope: 'process' },
    }),
  });
  // Booting the app IS the fixture — `pipeline.contract.test.ts` says why the budget is 30s.
}, 30_000);

contractTest('signed in, the page names the client and carries both answers as forms', async () => {
  const cookie = await signIn();
  const query = await authorizeQuery();
  const page = await call(`/oauth/consent?${query}`, { headers: { cookie, accept: 'text/html' } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Desktop');
  expect(html).toContain('action="/api/connections/approve"');
  expect(html).toContain('action="/api/connections/deny"');
  expect(html).not.toContain('⟦');
});

contractTest(
  'approving answers a 303 to the client with a code; denying with access_denied',
  async () => {
    const cookie = await signIn();
    const approved = await decide('/api/connections/approve', cookie, await authorizeQuery());
    expect(approved.status).toBe(303);
    const back = new URL(approved.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(back.searchParams.get('state')).toBe('st');

    const denied = await decide('/api/connections/deny', cookie, await authorizeQuery());
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
  },
);

contractTest('signed out, the page bounces to sign-in and keeps the request', async () => {
  const query = await authorizeQuery();
  const page = await call(`/oauth/consent?${query}`, { headers: { accept: 'text/html' } });
  expect(page.status).toBe(303);
  expect(page.headers.get('location')).toContain('/signin?next=');
});

contractTest(
  'a request naming no known client renders a refusal, not the two answers',
  async () => {
    const cookie = await signIn();
    const page = await call('/oauth/consent?response_type=code&client_id=nobody', {
      headers: { cookie, accept: 'text/html' },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-refused="true"');
    expect(html).not.toContain('/api/connections/approve');
  },
);

contractTest(
  'a self-registered client is never redirected to on a refusal — it is rendered',
  async () => {
    // Its redirect_uri is whatever the registrant typed: following it would make this origin an
    // open redirector for anyone who can POST /oauth/register.
    const cookie = await signIn();
    const query = (await authorizeQuery()).replace('response_type=code', 'response_type=token');
    const page = await call(`/oauth/consent?${query}`, {
      headers: { cookie, accept: 'text/html' },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-refused="true"');
  },
);

contractTest('the page names where the code will be sent', async () => {
  const cookie = await signIn();
  const page = await call(`/oauth/consent?${await authorizeQuery()}`, {
    headers: { cookie, accept: 'text/html' },
  });
  expect(await page.text()).toContain('data-redirect-host="127.0.0.1:33418"');
});
