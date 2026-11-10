// The IdentityProvider conformance suite over both adapters `@ultimat3/auth` ships — SAML against
// its in-process IdP, OIDC against a stubbed GitHub — and the proof it can fail: a provider that
// accepts any answer, and one that never spends an answer.

import { describe, expect, test } from 'bun:test';
import { type IdentityProvider, oidcIdentityProvider, samlIdentityProvider } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { encodeResponse, readAuthnRequest, samlTestIdp } from '../../auth/src/saml-idp-fixture';
import {
  IDENTITY_PROVIDER_CHECKS,
  type IdentityProviderHarness,
  identityProviderConformance,
} from './identity-provider-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const SP = 'https://app.example.test/saml/metadata';
const ACS = 'https://app.example.test/auth/sso/corp/callback';

async function samlHarness(): Promise<IdentityProviderHarness> {
  const idp = await samlTestIdp();
  return {
    provider: samlIdentityProvider({
      id: 'corp',
      idp: idp.idp,
      spEntityId: SP,
      trustEmail: true,
      emailDomains: ['corp.example'],
    }),
    callbackUrl: ACS,
    clock: frozenClock(NOW),
    async answer(redirect) {
      const request = readAuthnRequest(redirect.location);
      const xml = await idp.responseXml({
        requestId: request.id,
        acsUrl: ACS,
        audience: SP,
        now: NOW,
      });
      return { SAMLResponse: encodeResponse(xml), RelayState: request.relayState };
    },
    tamper(params) {
      const xml = new TextDecoder().decode(
        Uint8Array.from(atob(params['SAMLResponse'] ?? ''), (c) => c.charCodeAt(0)),
      );
      return { ...params, SAMLResponse: encodeResponse(xml.replace('>u-1001<', '>root<')) };
    },
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function oidcHarness(): IdentityProviderHarness {
  const callbackUrl = 'https://app.example.test/auth/sso/github/callback';
  return {
    provider: oidcIdentityProvider({
      provider: 'github',
      credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
      fetch: async (url) => {
        if (url.endsWith('/access_token'))
          return json({ access_token: 'gho_x', token_type: 'bearer' });
        if (url.endsWith('/user')) return json({ id: 583231, login: 'octocat' });
        return json([{ email: 'octo@example.com', primary: true, verified: true }]);
      },
    }),
    callbackUrl,
    clock: frozenClock(NOW),
    async answer(redirect) {
      return { state: new URL(redirect.location).searchParams.get('state') ?? '', code: 'c0de' };
    },
    tamper: (params) => ({ ...params, state: 'forged-state' }),
  };
}

describe(testName('unit', 'the SAML identity provider'), () => {
  behavesLike(identityProviderConformance, samlHarness);
});

describe(testName('unit', 'the OIDC identity provider'), () => {
  behavesLike(identityProviderConformance, oidcHarness);
});

/** Believes whatever comes back, under whatever state. */
const credulous = (): IdentityProvider => ({
  id: 'credulous',
  protocol: 'oidc',
  callbackMethod: 'GET',
  begin: async () => ({
    location: 'https://idp.example.test/authorize',
    state: crypto.randomUUID(),
  }),
  answers: () => true,
  complete: async ({ params }) => ({
    profile: {
      provider: 'credulous',
      providerAccountId: params['sub'] ?? 'anyone',
      email: null,
      emailVerified: false,
      name: null,
    },
    expiresAt: null,
    claims: {},
  }),
});

const brokenHarness = (provider: IdentityProvider): IdentityProviderHarness => ({
  provider,
  callbackUrl: 'https://app.example.test/auth/sso/credulous/callback',
  clock: frozenClock(NOW),
  answer: async () => ({ sub: 'u-1' }),
  tamper: (params) => ({ ...params, sub: 'root' }),
});

const check = (name: string) =>
  IDENTITY_PROVIDER_CHECKS.find((each) => each.name.includes(name)) ??
  expect.unreachable(`no conformance check named ${name}`);

describe(testName('unit', 'a provider that breaks the contract fails conformance'), () => {
  test('one that accepts a tampered answer', async () => {
    await expect(check('tampered').run(brokenHarness(credulous()))).rejects.toThrow();
  });

  test('one that completes the same answer twice', async () => {
    await expect(check('completes once').run(brokenHarness(credulous()))).rejects.toThrow();
  });

  test('one that ignores whose state it was handed', async () => {
    await expect(check('another begin').run(brokenHarness(credulous()))).rejects.toThrow();
  });

  test('one that calls any answer its own', async () => {
    await expect(check('answers()').run(brokenHarness(credulous()))).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = IDENTITY_PROVIDER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
