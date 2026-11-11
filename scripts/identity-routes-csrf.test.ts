// The sign-in routes behind the REAL `@ultimat3/http` pipeline. A SAML IdP answers with an
// auto-submitted cross-site form, which the csrf stage refuses on any route that does not declare
// otherwise — every SAML login was a `403 X_CSRF_BLOCKED` once mounted. auth and http are both
// tier 2 and cannot import each other; this file can import both.

import { describe, expect, test } from 'bun:test';
import {
  defineAuth,
  identityProviderRoutes,
  memoryAuthAdapter,
  oidcIdentityProvider,
  samlIdentityProvider,
} from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter, type Route } from '@ultimat3/http';
import { encodeResponse, readAuthnRequest, samlTestIdp } from '../packages/auth/src/saml-test-idp';

const BASE = 'https://app.example.test';
const SP = 'https://app.example.test/saml/metadata';
const NOW = new Date('2026-11-09T12:00:00.000Z');

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function mounted() {
  const idp = await samlTestIdp();
  const auth = defineAuth({
    adapter: memoryAuthAdapter(),
    clock: frozenClock(NOW),
    providers: ['corp', 'github'],
  });
  const legs = identityProviderRoutes(auth, {
    baseUrl: BASE,
    secret: 's'.repeat(40),
    providers: [
      samlIdentityProvider({
        id: 'corp',
        idp: idp.idp,
        spEntityId: SP,
        trustEmail: true,
        emailDomains: ['corp.example'],
      }),
      oidcIdentityProvider({
        provider: 'github',
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        fetch: async (url) => {
          if (url.endsWith('/access_token'))
            return json({ access_token: 'g', token_type: 'bearer' });
          if (url.endsWith('/user')) return json({ id: 583231, login: 'octocat' });
          return json([{ email: 'octo@example.com', primary: true, verified: true }]);
        },
      }),
    ],
  });
  // The documented mount: the pipeline's request carries the bare one as `raw`, and the
  // descriptor's `meta` is spread as the route's — the csrf and authenticate claims included.
  const routes: Route[] = [legs.start, legs.callback, legs.acs].map((leg) => ({
    method: leg.method,
    path: leg.path,
    handler: (request) => leg.handle(request.raw),
    meta: leg.meta,
  }));
  const pipeline = httpPipeline({
    table: httpRouter(routes),
    config: defineHttpConfig({ dev: false, buildId: null, rateLimit: { scope: 'process' } }),
  });
  const send = (path: string, init: RequestInit = {}, cookie = '') =>
    pipeline.handle(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(cookie === '' ? {} : { cookie }),
        },
      }),
      { role: 'web', ip: '203.0.113.9' },
    );
  return { idp, send };
}

const cookiePair = (response: Response): string =>
  (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';

describe('the sign-in routes behind the http pipeline', () => {
  test("the SAML ACS takes the IdP's cross-site form POST", async () => {
    const { idp, send } = await mounted();
    const start = await send('/auth/sso/corp');
    expect(start.status).toBe(302);
    const request = readAuthnRequest(start.headers.get('location') ?? '');
    const xml = await idp.responseXml({
      requestId: request.id,
      acsUrl: `${BASE}/auth/sso/corp/callback`,
      audience: SP,
      now: NOW,
    });
    const answer = await send(
      '/auth/sso/corp/callback',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://idp.example.test',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        },
        body: new URLSearchParams({
          SAMLResponse: encodeResponse(xml),
          RelayState: request.relayState,
        }),
      },
      cookiePair(start),
    );
    expect(answer.status).toBe(303);
  });

  test("the OIDC callback takes the IdP's cross-site top-level redirect", async () => {
    const { send } = await mounted();
    const start = await send('/auth/sso/github');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const answer = await send(
      `/auth/sso/github/callback?code=c0de&state=${state}`,
      { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } },
      cookiePair(start),
    );
    expect(answer.status).toBe(303);
  });

  test('a cross-site POST to the ACS without the state cookie is still refused, by the state', async () => {
    const { send } = await mounted();
    const answer = await send('/auth/sso/corp/callback', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
      },
      body: 'SAMLResponse=x&RelayState=y',
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ code: 'X_OAUTH_STATE_INVALID' });
  });
});
