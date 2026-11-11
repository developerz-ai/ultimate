// The SAML fake against the REAL verifier: `samlIdentityProvider` reads its metadata, sends the
// browser out, and accepts the fake's signed answer for the request it read off that redirect —
// then refuses each `tamper` with the code a real IdP's broken response gets. No socket opens.

import { describe, expect, test } from 'bun:test';
import { memoryTotpReplayGuard, parseSamlMetadata, samlIdentityProvider } from '@ultimat3/auth';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type FakeSamlTamper, fakeSamlIdentityProvider } from './fake-saml-identity-provider';

const clock = frozenClock('2026-11-10T09:00:00.000Z');
const SP = 'https://app.example.test/saml/metadata';
const ACS = 'https://app.example.test/auth/sso/corp/callback';

const setup = async () => {
  const idp = await fakeSamlIdentityProvider({
    audience: SP,
    clock,
    users: [
      { nameId: 'u-ada', email: 'ada@corp.example', name: 'Ada' },
      { nameId: 'u-bob', email: 'bob@corp.example' },
    ],
  });
  const provider = samlIdentityProvider({
    id: 'corp',
    idp: parseSamlMetadata(idp.metadataXml),
    spEntityId: SP,
    trustEmail: true,
    emailDomains: ['corp.example'],
  });
  const signIn = async () => {
    const redirect = await provider.begin({ callbackUrl: ACS, clock });
    const params = await idp.answer(redirect.location);
    return provider.complete({
      state: redirect.state,
      params,
      callbackUrl: ACS,
      clock,
      replay: memoryTotpReplayGuard(),
    });
  };
  return { idp, signIn };
};

const codeOf = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => 'accepted',
    (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
  );

describe('fakeSamlIdentityProvider', () => {
  test('a sign-in completes as the first user, then as whoever signInAs names', async () => {
    const { idp, signIn } = await setup();
    expect((await signIn()).profile).toEqual({
      provider: 'corp',
      providerAccountId: 'u-ada',
      email: 'ada@corp.example',
      emailVerified: true,
      name: 'Ada',
    });
    idp.signInAs('u-bob');
    expect((await signIn()).profile.providerAccountId).toBe('u-bob');
  });

  test('the AuthnRequest the SP sent is readable: its id and where to post back', async () => {
    const { idp } = await setup();
    const provider = samlIdentityProvider({
      id: 'corp',
      idp: parseSamlMetadata(idp.metadataXml),
      spEntityId: SP,
      trustEmail: false,
    });
    const request = idp.readAuthnRequest(
      (await provider.begin({ callbackUrl: ACS, clock })).location,
    );
    expect([request.id.startsWith('_'), request.acsUrl, request.relayState.length > 0]).toEqual([
      true,
      ACS,
      true,
    ]);
  });

  const TAMPERS: readonly (readonly [string, FakeSamlTamper])[] = [
    ['wrong audience', { wrongAudience: true }],
    ['expired', { expired: true }],
    ['unsigned', { unsigned: true }],
    ['wrong key', { wrongKey: true }],
  ];
  for (const [label, flags] of TAMPERS) {
    test(`tamper: ${label} is refused, and tamper({}) restores honesty`, async () => {
      const { idp, signIn } = await setup();
      idp.tamper(flags);
      expect(await codeOf(signIn())).toMatch(/^X_SAML_/);
      idp.tamper({});
      expect(await codeOf(signIn())).toBe('accepted');
    });
  }

  test('an unknown user is refused where it is named', async () => {
    const { idp } = await setup();
    expect(() => idp.signInAs('u-nobody')).toThrow(/u-nobody/);
  });
});
