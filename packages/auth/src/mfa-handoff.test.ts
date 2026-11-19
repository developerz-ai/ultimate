// An MFA-enrolled user through the BUILT-IN sign-in routes. The failure first: the callback caught
// `X_MFA_REQUIRED`, served a 401 that drops `meta`, and the challenge was gone — so nobody with a
// second factor could finish SSO. With `mfaPath` the challenge travels in a `__Host-` cookie, and
// the proof is that `completeMfa` accepts the one that travelled.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, installLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { oidcIdentityProvider } from './identity-provider-oidc';
import { identityProviderRoutes } from './identity-provider-routes';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import { totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { clearMfaChallengeCookie, MFA_CHALLENGE_COOKIE, readMfaChallenge } from './mfa-handoff';
import { saveTotpSecret } from './mfa-secret';
import type { OAuthFetch } from './oauth-exchange';
import { credentials, json } from './oauth-login-fixture';
import { oauthLogin } from './oauth-route';
import { samlIdentityProvider } from './saml-provider';
import { encodeResponse, readAuthnRequest, samlTestIdp } from './saml-test-idp';
import { ACS_URL, SAML_NOW, SP_ENTITY_ID } from './saml-test-support-fixture';

const BASE = 'https://app.example.test';
const SECRET = 's'.repeat(40);
const TOTP = 'JBSWY3DPEHPK3PXP';
const MFA_PATH = '/sign-in/mfa';

const githubFetch: OAuthFetch = async (url) => {
  if (url === 'https://github.com/login/oauth/access_token')
    return json({ access_token: 'gho_x', token_type: 'bearer' });
  if (url === 'https://api.github.com/user') return json({ id: 583231, login: 'octocat' });
  if (url === 'https://api.github.com/user/emails') {
    return json([{ email: 'octo@example.com', primary: true, verified: true }]);
  }
  return expect.unreachable(`unexpected endpoint: ${url}`);
};

let adapter: MemoryAuthAdapter;
let auth: Auth;
let logged: string[];
let releaseLogSink: () => void;

beforeEach(() => {
  adapter = memoryAuthAdapter();
  auth = defineAuth({ adapter, clock: frozenClock(SAML_NOW), providers: ['corp', 'github'] });
  logged = [];
  releaseLogSink = installLogSink((line) => {
    logged.push(line);
  });
});

afterEach(() => {
  releaseLogSink();
});

/** A verified user the IdP's answer links to, with a second factor enrolled. */
async function enrol(email: string): Promise<string> {
  const user = await adapter.createUser({
    id: '00000000-0000-7000-8000-0000000000aa',
    email,
    passwordHash: null,
    orgId: null,
    roles: [],
    scopes: [],
    externalId: null,
    createdAt: SAML_NOW,
  });
  await adapter.updateUser(user.id, { emailVerifiedAt: SAML_NOW });
  await saveTotpSecret(auth, user.id, TOTP);
  return user.id;
}

const pairOf = (setCookie: string | null | undefined): string =>
  (setCookie ?? '').split(';')[0] ?? '';

type Callback = (options: { readonly mfaPath?: string }) => Promise<Response>;

/** The three built-in callbacks, each driven start → IdP → callback for an enrolled user. */
const DOORS: Readonly<Record<string, { email: string; event: string; call: Callback }>> = {
  'oauthLogin(auth).callback': {
    email: 'octo@example.com',
    event: 'auth.oauth.refused',
    async call(options) {
      const routes = oauthLogin(auth, {
        credentials,
        fetch: githubFetch,
        secret: SECRET,
        baseUrl: BASE,
        ...options,
      });
      const out = await routes.start.handle(new Request(`${BASE}/auth/sso/github`));
      const state = new URL(out.headers.get('location') ?? '').searchParams.get('state') ?? '';
      return routes.callback.handle(
        new Request(`${BASE}/auth/sso/github/callback?state=${state}&code=c0de`, {
          headers: { cookie: pairOf(out.headers.get('set-cookie')) },
        }),
      );
    },
  },
  'identityProviderRoutes OIDC callback': {
    email: 'octo@example.com',
    event: 'auth.sso.refused',
    async call(options) {
      const github = oidcIdentityProvider({ provider: 'github', credentials, fetch: githubFetch });
      const routes = identityProviderRoutes(auth, {
        providers: [github],
        baseUrl: BASE,
        secret: SECRET,
        ...options,
      });
      const out = await routes.start.handle(new Request(`${BASE}/auth/sso/github`));
      const state = new URL(out.headers.get('location') ?? '').searchParams.get('state') ?? '';
      return routes.callback.handle(
        new Request(`${BASE}/auth/sso/github/callback?state=${state}&code=c0de`, {
          headers: { cookie: pairOf(out.headers.get('set-cookie')) },
        }),
      );
    },
  },
  'identityProviderRoutes SAML ACS': {
    email: 'ada@corp.example',
    event: 'auth.sso.refused',
    async call(options) {
      const idp = await samlTestIdp();
      const corp = samlIdentityProvider({
        id: 'corp',
        idp: idp.idp,
        spEntityId: SP_ENTITY_ID,
        trustEmail: true,
        emailDomains: ['corp.example'],
      });
      const routes = identityProviderRoutes(auth, {
        providers: [corp],
        baseUrl: BASE,
        secret: SECRET,
        ...options,
      });
      const out = await routes.start.handle(new Request(`${BASE}/auth/sso/corp`));
      const request = readAuthnRequest(out.headers.get('location') ?? '');
      const xml = await idp.responseXml({
        requestId: request.id,
        acsUrl: ACS_URL,
        audience: SP_ENTITY_ID,
        now: SAML_NOW,
      });
      return routes.acs.handle(
        new Request(`${BASE}/auth/sso/corp/callback`, {
          method: 'POST',
          headers: {
            cookie: pairOf(out.headers.get('set-cookie')),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            SAMLResponse: encodeResponse(xml),
            RelayState: request.relayState,
          }),
        }),
      );
    },
  },
};

for (const [door, { email, event, call }] of Object.entries(DOORS)) {
  describe(`${door}: an MFA-enrolled user`, () => {
    test("an MFA-enrolled user's callback hands over a challenge completeMfa accepts", async () => {
      const userId = await enrol(email);
      const answer = await call({ mfaPath: MFA_PATH });

      expect(answer.status).toBe(303);
      expect(answer.headers.get('location')).toBe(MFA_PATH);
      const cookies = answer.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith('__Host-x_session='))).toBe(false);
      // The spent state cookie is still cleared: the IdP's answer was this browser's.
      expect(cookies.some((c) => c.startsWith('__Host-x_sso_'))).toBe(true);
      const set = cookies.find((c) => c.startsWith(`${MFA_CHALLENGE_COOKIE}=`)) ?? '';
      for (const attribute of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Lax', 'Max-Age=300']) {
        expect(set).toContain(attribute);
      }
      expect(set).not.toContain('Domain=');

      // The app's page, on the next request: the cookie is all it needs.
      const next = new Request(`${BASE}${MFA_PATH}`, { headers: { cookie: pairOf(set) } });
      const challenge = readMfaChallenge(next) ?? '';
      const result = await completeMfa(auth, challenge, totpCode(TOTP, totpStep(SAML_NOW)));
      expect(result.session.userId).toBe(userId);
      expect(result.session.mfaSatisfied).toBe(true);

      // Nowhere another origin or a log reads: not the URL, not a body, not a log line.
      expect(await answer.text()).toBe('');
      expect(logged.join('\n')).not.toContain(challenge);
    });

    test('with no mfaPath the refusal is the old 401, and its fix names the option', async () => {
      await enrol(email);
      const answer = await call({});

      expect(answer.status).toBe(401);
      const cookies = answer.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith(MFA_CHALLENGE_COOKIE))).toBe(false);
      expect(cookies.some((c) => c.startsWith('__Host-x_session='))).toBe(false);
      const body = (await answer.json()) as { code: string; fix: string };
      expect(body.code).toBe('X_MFA_REQUIRED');
      expect(body.fix).toBe('x errors explain X_MFA_REQUIRED --json');
      const line = logged.findLast((entry) => entry.includes(event)) ?? '';
      expect(line).toContain("mfaPath: '/sign-in/mfa'");
      expect(line).toContain('readMfaChallenge(request)');
      // The fix a hand-written handler gets is a lie here: there is no handler to catch it in.
      expect(line).not.toContain('catch X_MFA_REQUIRED in your sign-in handler');
    });
  });
}

describe('mfaPath is a path on this origin, or the call refuses', () => {
  const HOSTILE = ['//evil.example/mfa', 'https://evil.example/mfa', '/\\evil.example', 'mfa'];

  // `//` and `//[` are not parseable as a URL at all: `new URL` threw a bare TypeError, uncoded.
  test.each([...HOSTILE, '/a/../b', '/mfa?next=x', '/mfa#x', '//', '//['])('%s', (mfaPath) => {
    expect(() => oauthLogin(auth, { mfaPath })).toThrow(
      expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
    );
    expect(() => identityProviderRoutes(auth, { providers: [], mfaPath })).toThrow(
      expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
    );
  });

  test('the cookie is cleared by the one helper that names it', () => {
    const cleared = clearMfaChallengeCookie();
    expect(cleared).toStartWith(`${MFA_CHALLENGE_COOKIE}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(readMfaChallenge(new Request(BASE))).toBeNull();
  });
});
