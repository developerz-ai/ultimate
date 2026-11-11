/**
 * The SAML sign-in, driven end to end through Postly's OWN declaration — its provider id, its
 * trusted domains, its landing path — against `@ultimat3/testing`'s fake IdP: the start leg's
 * redirect, the IdP's signed answer POSTed to the ACS, and the session that comes back. Then the
 * answers that must be refused: tampered, replayed, and an address outside the directory's domain.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { authenticate, memoryAuthAdapter, readSessionCookie } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { type FakeSamlIdentityProvider, fakeSamlIdentityProvider } from '@ultimat3/testing';
import { postlyAuth } from './login';
import { AFTER_SIGN_IN, SSO_PROVIDER } from './sign-in-paths';
import { postlySso, spEntityId, ssoConfigFrom } from './sso';

const ORIGIN = 'https://postly.test';
/** 32 bytes, the length the sealed state demands — never Postly's real `SESSION_SECRET`. */
const SECRET = 'postly-test-handshake-secret-000';
const clock = frozenClock('2026-11-10T09:00:00.000Z');

let idp: FakeSamlIdentityProvider;
let auth: ReturnType<typeof postlyAuth>;
let routes: ReturnType<typeof postlySso>;

beforeEach(async () => {
  idp = await fakeSamlIdentityProvider({
    audience: spEntityId(ORIGIN),
    clock,
    users: [
      { nameId: 'u-ada', email: 'ada@acme.example', name: 'Ada Okonjo' },
      { nameId: 'u-eve', email: 'eve@elsewhere.example', name: 'Eve' },
    ],
  });
  auth = postlyAuth({ adapter: memoryAuthAdapter(), clock, origin: ORIGIN });
  routes = postlySso(
    auth,
    { idpMetadataXml: idp.metadataXml, emailDomains: ['acme.example'] },
    { baseUrl: ORIGIN, secret: SECRET },
  );
});

const cookiePair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

/** Start, let the IdP answer, POST that answer to the ACS with the sealed state cookie. */
async function signIn(form?: Readonly<Record<string, string>>) {
  const start = await routes.start.handle(new Request(`${ORIGIN}/auth/sso/${SSO_PROVIDER}`));
  const location = start.headers.get('location') ?? '';
  const answer = form ?? (await idp.answer(location));
  const acs = await routes.acs.handle(
    new Request(`${ORIGIN}/auth/sso/${SSO_PROVIDER}/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookiePair(start.headers.getSetCookie()[0] ?? ''),
      },
      body: new URLSearchParams({ ...answer }),
    }),
  );
  return { start, location, answer, acs };
}

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { code?: unknown }).code;

describe('SAML sign-in', () => {
  test('a signed answer from the directory signs the member in and lands on the feed', async () => {
    const { start, acs } = await signIn();

    expect(start.status).toBe(302);
    // The ACS the IdP is told to answer is Postly's own mount.
    expect(idp.readAuthnRequest(start.headers.get('location') ?? '').acsUrl).toBe(
      `${ORIGIN}/auth/sso/${SSO_PROVIDER}/callback`,
    );
    expect(acs.status).toBe(303);
    expect(acs.headers.get('location')).toBe(AFTER_SIGN_IN);
    const session = new Request(ORIGIN, {
      headers: { cookie: acs.headers.getSetCookie().map(cookiePair).join('; ') },
    });
    const token = readSessionCookie(session, auth.sessions.policy);
    expect(token).not.toBeNull();
    const user = await auth.adapter.findUserById((await authenticate(auth, token)).id);
    expect(user?.email).toBe('ada@acme.example');
  });

  test('a tampered answer is refused by code, and signs nobody in', async () => {
    idp.tamper({ wrongAudience: true });
    const { acs } = await signIn();

    expect(acs.status).toBeGreaterThanOrEqual(400);
    expect(await codeOf(acs)).toBe('X_SAML_RESPONSE_INVALID');
    expect(acs.headers.getSetCookie().some((c) => c.startsWith('__Host-x_session='))).toBe(false);
  });

  test('an answer is spent once: replayed into a fresh login, it is refused', async () => {
    const first = await signIn();
    expect(first.acs.status).toBe(303);

    const replay = await signIn(first.answer);
    expect(replay.acs.status).toBeGreaterThanOrEqual(400);
    expect(await codeOf(replay.acs)).toMatch(/^X_[A-Z_]+$/);
  });

  test('an address outside the directory’s domain neither signs up nor signs in', async () => {
    idp.signInAs('u-eve');
    const { acs } = await signIn();

    expect(acs.status).toBeGreaterThanOrEqual(400);
    expect(await auth.adapter.findUserByEmail('eve@elsewhere.example')).toBeNull();
  });
});

describe('the deploy’s configuration', () => {
  test('no IdP configured is none', () => {
    expect(ssoConfigFrom({})).toBeNull();
  });

  test('a configured IdP names its metadata and every listed domain', () => {
    const env = {
      POSTLY_SSO_IDP_METADATA: idp.metadataXml,
      POSTLY_SSO_EMAIL_DOMAINS: 'acme.example, acme-labs.example',
    };
    expect(ssoConfigFrom(env)?.emailDomains).toEqual(['acme.example', 'acme-labs.example']);
  });
});
