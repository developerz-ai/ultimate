// The SAML adapter end to end over the in-process IdP: a signed fixture is accepted and read into
// one profile, and every binding and condition check refuses with its own `meta.check`.

import { describe, expect, test } from 'bun:test';
import { NAMEID_EMAIL, NAMEID_TRANSIENT } from './saml-dom';
import { samlIdentityProvider } from './saml-provider';
import { readAuthnRequest, samlTestIdp } from './saml-test-idp';
import {
  ACS_URL,
  refusalOf,
  SAML_NOW,
  SP_ENTITY_ID,
  samlHarness,
} from './saml-test-support-fixture';

const minutes = (n: number): Date => new Date(SAML_NOW.getTime() + n * 60_000);

describe('samlIdentityProvider: begin', () => {
  test('redirects to the metadata SSO URL with a deflated AuthnRequest and a RelayState', async () => {
    const { provider, clock } = await samlHarness();
    const redirect = await provider.begin({ callbackUrl: ACS_URL, clock });
    expect(redirect.location.startsWith('https://idp.example.test/sso?SAMLRequest=')).toBe(true);
    const request = readAuthnRequest(redirect.location);
    expect(request.id).toMatch(/^_[A-Za-z0-9_-]+$/);
    expect(request.relayState.length).toBeLessThanOrEqual(80);
    expect(request.xml).toContain(`AssertionConsumerServiceURL="${ACS_URL}"`);
    expect(request.xml).toContain(`<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`);
    expect(request.xml).toContain('IssueInstant="2026-11-09T12:00:00Z"');
  });

  test('two begins never share a request id or a RelayState', async () => {
    const harness = await samlHarness();
    const [a, b] = [await harness.begin(), await harness.begin()];
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.relayState).not.toBe(b.relayState);
  });
});

describe('samlIdentityProvider: complete', () => {
  test('a signed assertion is accepted and read into one profile', async () => {
    const login = await (await samlHarness()).begin();
    const identity = await login.complete(await login.xml());
    expect(identity.profile).toEqual({
      provider: 'corp',
      providerAccountId: 'u-1001',
      email: 'ada@corp.example',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    expect(identity.claims['sessionIndex']).toBe('s-1');
  });

  test('a response signed on both levels is accepted', async () => {
    const login = await (await samlHarness()).begin();
    expect(await refusalOf(login.complete(await login.xml({ signResponse: true })))).toBe(
      'accepted',
    );
  });

  test('an emailAddress NameID stands in for a missing email attribute', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({
      nameId: 'grace@corp.example',
      nameIdFormat: NAMEID_EMAIL,
      email: null,
    });
    const identity = await login.complete(xml);
    expect(identity.profile.email).toBe('grace@corp.example');
  });

  test('no address at all is an unverified, address-less profile', async () => {
    const login = await (await samlHarness()).begin();
    const identity = await login.complete(await login.xml({ email: null }));
    expect(identity.profile.email).toBeNull();
    expect(identity.profile.emailVerified).toBe(false);
  });

  const cases = [
    ['wrong audience', { audience: 'https://other-sp.example.test' }, 'audience'],
    ['wrong destination', { acsUrl: 'https://evil.example.test/acs' }, 'destination'],
    ['answers another request', { requestId: '_someone-else' }, 'in-response-to'],
    ['expired', { now: minutes(-30) }, 'expired'],
    ['not yet valid', { notBefore: minutes(10) }, 'not-before'],
    ['another issuer', { issuer: 'https://evil.example.test/idp' }, 'issuer'],
    ['IdP said no', { status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' }, 'status'],
    ['transient NameID', { nameIdFormat: NAMEID_TRANSIENT }, 'subject'],
    [
      'SHA-1 digest claimed',
      { digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1' },
      'algorithm',
    ],
  ] as const;
  for (const [name, overrides, check] of cases) {
    test(`refused: ${name}`, async () => {
      const login = await (await samlHarness()).begin();
      const verdict = await refusalOf(login.complete(await login.xml(overrides)));
      expect(verdict).toBe(`X_SAML_RESPONSE_INVALID:${check}`);
    });
  }

  test('refused: a recipient mismatch on the signed confirmation alone', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({ recipient: 'https://evil.example.test/acs' });
    expect(await refusalOf(login.complete(xml))).toBe('X_SAML_RESPONSE_INVALID:recipient');
  });

  test('refused: the RelayState is not the one this browser was sent with', async () => {
    const login = await (await samlHarness()).begin();
    expect(await refusalOf(login.complete(await login.xml(), 'forged'))).toBe(
      'X_SAML_RESPONSE_INVALID:relay-state',
    );
  });

  test('refused: a state that is not a stored SAML request', async () => {
    const { provider, clock, replay } = await samlHarness();
    const call = provider.complete({
      state: '{}',
      params: {},
      callbackUrl: ACS_URL,
      clock,
      replay,
    });
    expect(await refusalOf(call)).toBe('X_SAML_RESPONSE_INVALID:relay-state');
  });

  test('refused: the same assertion a second time', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml();
    expect(await refusalOf(login.complete(xml))).toBe('accepted');
    expect(await refusalOf(login.complete(xml))).toBe('X_SAML_RESPONSE_INVALID:replay');
  });
});

describe('samlIdentityProvider: an asserted address is trusted only inside emailDomains', () => {
  const emailOf = async (email: string) => {
    const login = await (await samlHarness()).begin();
    return (await login.complete(await login.xml({ email }))).profile;
  };

  test('an address in a listed domain is verified, case-folded', async () => {
    expect((await emailOf('ada@CORP.example')).emailVerified).toBe(true);
  });

  test("another tenant's address is NOT verified, so it can never link to that account", async () => {
    const profile = await emailOf('ceo@other-tenant.example');
    expect(profile.email).toBe('ceo@other-tenant.example');
    expect(profile.emailVerified).toBe(false);
  });

  test('a subdomain is its own domain: it must be listed', async () => {
    expect((await emailOf('ada@eu.corp.example')).emailVerified).toBe(false);
  });

  test('trustEmail without a domain list refuses at construction', async () => {
    const idp = await samlTestIdp();
    const build = (emailDomains: readonly string[]) => () =>
      samlIdentityProvider({
        id: 'x',
        idp: idp.idp,
        spEntityId: SP_ENTITY_ID,
        trustEmail: true,
        emailDomains,
      });
    expect(build([])).toThrow(expect.objectContaining({ code: 'X_CONFIG_INVALID' }));
    expect(build(['*.corp.example'])).toThrow(
      expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
    );
  });
});
