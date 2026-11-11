// The two legs over both adapters, as a browser drives them: start → IdP → callback → session,
// and every way the callback refuses (no state cookie, a replay, an unknown id, a wrong method).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineAuth } from './auth';
import type { IdentityProvider } from './identity-provider';
import { oidcIdentityProvider } from './identity-provider-oidc';
import { identityProviderRoutes } from './identity-provider-routes';
import { memoryAuthAdapter } from './memory-adapter';
import type { OAuthFetch } from './oauth-exchange';
import { credentials, json } from './oauth-login-fixture';
import { samlIdentityProvider } from './saml-provider';
import { encodeResponse, readAuthnRequest, samlTestIdp, type TestIdp } from './saml-test-idp';
import { ACS_URL, SAML_NOW, SP_ENTITY_ID } from './saml-test-support-fixture';

const BASE = 'https://app.example.test';
const SECRET = 's'.repeat(40);

const githubFetch: OAuthFetch = async (url) => {
  if (url === 'https://github.com/login/oauth/access_token')
    return json({ access_token: 'gho_x', token_type: 'bearer' });
  if (url === 'https://api.github.com/user') return json({ id: 583231, login: 'octocat' });
  if (url === 'https://api.github.com/user/emails') {
    return json([{ email: 'octo@example.com', primary: true, verified: true }]);
  }
  return expect.unreachable(`unexpected endpoint: ${url}`);
};

async function setup(extra: readonly IdentityProvider[] = []) {
  const idp: TestIdp = await samlTestIdp();
  const adapter = memoryAuthAdapter();
  const corp = samlIdentityProvider({
    id: 'corp',
    idp: idp.idp,
    spEntityId: SP_ENTITY_ID,
    trustEmail: true,
    emailDomains: ['corp.example'],
  });
  const github = oidcIdentityProvider({ provider: 'github', credentials, fetch: githubFetch });
  const auth = defineAuth({ adapter, clock: frozenClock(SAML_NOW), providers: ['corp', 'github'] });
  const routes = identityProviderRoutes(auth, {
    providers: [corp, github, ...extra],
    baseUrl: BASE,
    secret: SECRET,
    successPath: '/home',
  });
  return { idp, adapter, routes };
}

const cookiePair = (setCookie: string | null): string => (setCookie ?? '').split(';')[0] ?? '';

describe('identityProviderRoutes: SAML', () => {
  async function started() {
    const env = await setup();
    const out = await env.routes.start.handle(new Request(`${BASE}/auth/sso/corp`));
    const request = readAuthnRequest(out.headers.get('location') ?? '');
    const xml = await env.idp.responseXml({
      requestId: request.id,
      acsUrl: ACS_URL,
      audience: SP_ENTITY_ID,
      now: SAML_NOW,
    });
    const post = (cookie: string) =>
      env.routes.acs.handle(
        new Request(`${BASE}/auth/sso/corp/callback`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SAMLResponse: encodeResponse(xml),
            RelayState: request.relayState,
          }),
        }),
      );
    return { ...env, out, post, cookie: cookiePair(out.headers.get('set-cookie')) };
  }

  test('start redirects to the IdP and seals the request in a SameSite=None cookie', async () => {
    const { out } = await started();
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toStartWith('https://idp.example.test/sso?SAMLRequest=');
    expect(out.headers.get('set-cookie')).toContain('SameSite=None');
    expect(out.headers.get('set-cookie')).toStartWith('__Host-x_sso_corp=');
  });

  test('the ACS POST signs the user in and lands on the fixed path', async () => {
    const { post, cookie, adapter } = await started();
    const answer = await post(cookie);
    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe('/home');
    expect(answer.headers.getSetCookie().some((c) => c.startsWith('__Host-x_session='))).toBe(true);
    expect((await adapter.findUserByEmail('ada@corp.example'))?.email).toBe('ada@corp.example');
  });

  test('the same POST twice is refused the second time', async () => {
    const { post, cookie } = await started();
    expect((await post(cookie)).status).toBe(303);
    const replay = await post(cookie);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code: string }).code).toBe('X_SAML_RESPONSE_INVALID');
  });

  test("a junk cross-site POST carrying the victim's cookie leaves their sign-in alive", async () => {
    const { routes, post, cookie } = await started();
    const junk = await routes.acs.handle(
      new Request(`${BASE}/auth/sso/corp/callback`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ SAMLResponse: 'junk', RelayState: 'not-theirs' }),
      }),
    );
    expect(junk.status).toBe(400);
    expect(junk.headers.getSetCookie().some((c) => c.startsWith('__Host-x_sso_corp=;'))).toBe(
      false,
    );
    expect((await post(cookie)).status).toBe(303);
  });

  test('a body over the cap is refused from its content-length, before it is read', async () => {
    const { routes, cookie } = await started();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 64) controller.close();
      },
    });
    const answer = await routes.acs.handle(
      new Request(`${BASE}/auth/sso/corp/callback`, {
        method: 'POST',
        headers: { cookie, 'content-length': String(4 * 1024 * 1024) },
        body,
      }),
    );
    expect(answer.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test('a POST with no state cookie (another browser) is refused', async () => {
    const { post } = await started();
    const answer = await post('');
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { code: string }).code).toBe('X_OAUTH_STATE_INVALID');
  });

  test("a tenant's own IdP asserting another tenant's verified address cannot sign in as them", async () => {
    const env = await setup();
    const victim = await env.adapter.createUser({
      id: '00000000-0000-7000-8000-000000000001',
      email: 'ceo@other-tenant.example',
      passwordHash: null,
      orgId: 'other-tenant',
      roles: ['owner'],
      scopes: [],
      externalId: null,
      createdAt: SAML_NOW,
    });
    await env.adapter.updateUser(victim.id, { emailVerifiedAt: SAML_NOW });
    const out = await env.routes.start.handle(new Request(`${BASE}/auth/sso/corp`));
    const request = readAuthnRequest(out.headers.get('location') ?? '');
    const xml = await env.idp.responseXml({
      requestId: request.id,
      acsUrl: ACS_URL,
      audience: SP_ENTITY_ID,
      now: SAML_NOW,
      email: 'ceo@other-tenant.example',
    });
    const answer = await env.routes.acs.handle(
      new Request(`${BASE}/auth/sso/corp/callback`, {
        method: 'POST',
        headers: { cookie: cookiePair(out.headers.get('set-cookie')) },
        body: new URLSearchParams({
          SAMLResponse: encodeResponse(xml),
          RelayState: request.relayState,
        }),
      }),
    );
    expect(answer.status).toBe(401);
    expect(answer.headers.getSetCookie().some((c) => c.startsWith('__Host-x_session='))).toBe(
      false,
    );
    expect(await env.adapter.findAccount('corp', 'u-1001')).toBeNull();
  });

  test('a GET on the SAML callback, and an unknown id, are one 404', async () => {
    const { routes } = await setup();
    const get = await routes.callback.handle(new Request(`${BASE}/auth/sso/corp/callback`));
    const unknown = await routes.start.handle(new Request(`${BASE}/auth/sso/okta`));
    expect([get.status, unknown.status]).toEqual([404, 404]);
  });

  test('two providers under one id refuse at construction', async () => {
    const idp = await samlTestIdp();
    const twin = samlIdentityProvider({
      id: 'corp',
      idp: idp.idp,
      spEntityId: 'x',
      trustEmail: false,
    });
    await expect(setup([twin])).rejects.toMatchObject({ code: 'X_CONFIG_INVALID' });
  });
});

describe('identityProviderRoutes: OIDC behind the same port', () => {
  test('start → callback signs in, and the callback cannot be replayed', async () => {
    const { routes, adapter } = await setup();
    const out = await routes.start.handle(new Request(`${BASE}/auth/sso/github`));
    expect(out.headers.get('set-cookie')).toContain('SameSite=Lax');
    const state = new URL(out.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = () =>
      routes.callback.handle(
        new Request(`${BASE}/auth/sso/github/callback?state=${state}&code=c0de`, {
          headers: { cookie: cookiePair(out.headers.get('set-cookie')) },
        }),
      );
    expect((await callback()).status).toBe(303);
    expect((await adapter.findUserByEmail('octo@example.com'))?.email).toBe('octo@example.com');
    expect((await callback()).status).toBe(400);
  });
});
