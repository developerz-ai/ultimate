// TEST-ONLY. The harness the SAML suites share: one SP over the test IdP, a begin that answers
// its own AuthnRequest, and the refusal reader — so each suite states only what it tampers with.

import { type Clock, frozenClock, isUltimateError } from '@ultimat3/core';
import type { IdentityProvider, VerifiedIdentity } from './identity-provider';
import { memoryTotpReplayGuard, type TotpReplayGuard } from './mfa';
import {
  readAuthnRequest,
  samlTestIdp,
  type TestIdp,
  type TestResponseSpec,
} from './saml-idp-fixture';
import { type SamlIdentityProviderConfig, samlIdentityProvider } from './saml-provider';

export const SAML_NOW = new Date('2026-11-09T12:00:00.000Z');
export const SP_ENTITY_ID = 'https://app.example.test/saml/metadata';
export const ACS_URL = 'https://app.example.test/auth/sso/corp/callback';

export interface SamlHarness {
  readonly idp: TestIdp;
  readonly provider: IdentityProvider;
  readonly clock: Clock;
  readonly replay: TotpReplayGuard;
  /** Begin a login; answer with `answer(spec)`, then `complete(xml)` the (possibly tampered) xml. */
  begin(): Promise<SamlLogin>;
}

export interface SamlLogin {
  readonly state: string;
  readonly requestId: string;
  readonly relayState: string;
  xml(overrides?: Partial<TestResponseSpec>): Promise<string>;
  complete(xml: string, relayState?: string): Promise<VerifiedIdentity>;
}

/** The email-trust half of the provider config, as each test states it. */
export type SamlTrust = Pick<SamlIdentityProviderConfig, 'trustEmail' | 'emailDomains'>;

export async function samlHarness(
  idp?: TestIdp,
  trust: SamlTrust = { trustEmail: true, emailDomains: ['corp.example'] },
): Promise<SamlHarness> {
  const own = idp ?? (await samlTestIdp());
  const clock = frozenClock(SAML_NOW);
  const replay = memoryTotpReplayGuard();
  const provider = samlIdentityProvider({
    id: 'corp',
    idp: own.idp,
    spEntityId: SP_ENTITY_ID,
    ...trust,
  } as SamlIdentityProviderConfig);
  return {
    idp: own,
    provider,
    clock,
    replay,
    async begin() {
      const redirect = await provider.begin({ callbackUrl: ACS_URL, clock });
      const request = readAuthnRequest(redirect.location);
      return {
        state: redirect.state,
        requestId: request.id,
        relayState: request.relayState,
        xml: (overrides = {}) =>
          own.responseXml({
            requestId: request.id,
            acsUrl: ACS_URL,
            audience: SP_ENTITY_ID,
            now: SAML_NOW,
            ...overrides,
          }),
        complete: (xml, relayState = request.relayState) =>
          provider.complete({
            state: redirect.state,
            params: {
              SAMLResponse: btoa(String.fromCharCode(...new TextEncoder().encode(xml))),
              RelayState: relayState,
            },
            callbackUrl: ACS_URL,
            clock,
            replay,
          }),
      };
    },
  };
}

/** `code:check` of the refusal, or what happened instead. */
export async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (!isUltimateError(error)) return `not-an-UltimateError: ${String(error)}`;
    const check = error.meta?.['check'];
    return typeof check === 'string' ? `${error.code}:${check}` : error.code;
  }
  return 'accepted';
}
