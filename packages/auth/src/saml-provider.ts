// Single responsibility: SAML 2.0 Web SSO (SP-initiated, HTTP-Redirect out, HTTP-POST back) as an
// `IdentityProvider`. `begin` mints the AuthnRequest; `complete` binds the answer to that request
// (RelayState + InResponseTo), verifies it (`verifySamlResponse`), claims its assertion ID once,
// and reads one profile out of it.

import { timingSafeEqual } from '@ultimat3/core';
import {
  type IdentityProvider,
  type IdentityRedirect,
  replayStepFor,
  type VerifiedIdentity,
} from './identity-provider';
import { isRecord } from './json';
import { assertFiniteAuthCount } from './policy-numbers';
import type { SamlAssertion } from './saml-assertion';
import { NAMEID_EMAIL } from './saml-dom';
import { isTrustedAddress, type SamlEmailTrust, samlTrustedDomains } from './saml-email-trust';
import { samlResponseInvalid } from './saml-errors';
import { type SamlIdpMetadata, samlMetadataKeys } from './saml-metadata';
import { samlAuthnRequest } from './saml-request';
import { verifySamlResponse } from './saml-response';

/** The attribute names enterprise IdPs put an address under: Entra/ADFS, LDAP `mail`, eduPerson. */
export const DEFAULT_SAML_EMAIL_ATTRIBUTES: readonly string[] = Object.freeze([
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
]);
export const DEFAULT_SAML_NAME_ATTRIBUTES: readonly string[] = Object.freeze([
  'displayName',
  'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
]);
/** One minute either way: what the major IdPs document as tolerable clock drift. */
export const DEFAULT_SAML_SKEW_MS = 60_000;

interface SamlProviderBase {
  readonly id: string;
  /** `parseSamlMetadata(xml)` — the trust anchor. Its certificates are the only keys believed. */
  readonly idp: SamlIdpMetadata;
  /** This SP's entity id: the Audience every assertion must name. */
  readonly spEntityId: string;
  readonly emailAttributes?: readonly string[] | undefined;
  readonly nameAttributes?: readonly string[] | undefined;
  /** Requested in the AuthnRequest's NameIDPolicy. Default persistent; transient is refused. */
  readonly nameIdFormat?: string | undefined;
  readonly skewMs?: number | undefined;
}

/**
 * `trustEmail` is REQUIRED, never defaulted: SAML carries no `email_verified`, so the app says
 * whether this IdP vouches for its addresses — and `true` names the exact `emailDomains` it owns.
 * An address outside them is unverified: it neither links to an existing account nor creates one.
 */
export type SamlIdentityProviderConfig = SamlProviderBase & SamlEmailTrust;

interface SamlState {
  readonly requestId: string;
  readonly relayState: string;
}

function readState(provider: string, state: string): SamlState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    parsed = null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed['requestId'] !== 'string' ||
    typeof parsed['relayState'] !== 'string'
  ) {
    throw samlResponseInvalid(provider, 'relay-state', 'the stored request is not a SAML request');
  }
  return { requestId: parsed['requestId'], relayState: parsed['relayState'] };
}

const firstOf = (assertion: SamlAssertion, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = assertion.attributes[name]?.find((one) => one.trim() !== '');
    if (value !== undefined) return value.trim();
  }
  return null;
};

function identityOf(
  config: SamlIdentityProviderConfig,
  trusted: ReadonlySet<string>,
  assertion: SamlAssertion,
): VerifiedIdentity {
  const email =
    firstOf(assertion, config.emailAttributes ?? DEFAULT_SAML_EMAIL_ATTRIBUTES) ??
    (assertion.nameIdFormat === NAMEID_EMAIL ? assertion.nameId : null);
  return {
    profile: {
      provider: config.id,
      providerAccountId: assertion.nameId,
      email,
      emailVerified: email !== null && isTrustedAddress(email, trusted),
      name: firstOf(assertion, config.nameAttributes ?? DEFAULT_SAML_NAME_ATTRIBUTES),
    },
    expiresAt: assertion.sessionNotOnOrAfter,
    claims: {
      issuer: assertion.issuer,
      nameIdFormat: assertion.nameIdFormat,
      sessionIndex: assertion.sessionIndex,
      attributes: assertion.attributes,
    },
  };
}

export function samlIdentityProvider(config: SamlIdentityProviderConfig): IdentityProvider {
  const skewMs = assertFiniteAuthCount(
    'saml.skewMs',
    config.skewMs ?? DEFAULT_SAML_SKEW_MS,
    'every NotBefore and NotOnOrAfter comparison answers false, so an expired assertion is accepted',
    0,
  );
  // Imported once, lazily, then shared: a certificate that yields no key refuses the first login
  // with X_SAML_METADATA_INVALID rather than every login quietly failing its signature check.
  let keys: Promise<readonly CryptoKey[]> | undefined;
  const id = config.id;
  const trusted = samlTrustedDomains(id, config);
  const provider: IdentityProvider = {
    id,
    protocol: 'saml',
    callbackMethod: 'POST',
    async begin({ callbackUrl, clock }): Promise<IdentityRedirect> {
      const request = samlAuthnRequest({
        idp: config.idp,
        spEntityId: config.spEntityId,
        acsUrl: callbackUrl,
        clock,
        nameIdFormat: config.nameIdFormat,
      });
      const state: SamlState = { requestId: request.id, relayState: request.relayState };
      return { location: request.location, state: JSON.stringify(state) };
    },
    answers(state, params) {
      try {
        return timingSafeEqual(readState(id, state).relayState, params['RelayState'] ?? '');
      } catch {
        return false;
      }
    },
    async complete({ state, params, callbackUrl, clock, replay }): Promise<VerifiedIdentity> {
      const stored = readState(id, state);
      if (!timingSafeEqual(stored.relayState, params['RelayState'] ?? '')) {
        throw samlResponseInvalid(
          id,
          'relay-state',
          'RelayState is not the one this browser was sent with',
        );
      }
      keys ??= samlMetadataKeys(config.idp);
      const now = clock.now();
      const assertion = await verifySamlResponse(params['SAMLResponse'] ?? '', {
        provider: id,
        idpEntityId: config.idp.entityId,
        keys: await keys,
        audience: config.spEntityId,
        recipient: callbackUrl,
        requestId: stored.requestId,
        now,
        skewMs,
      });
      const horizon = new Date(assertion.notOnOrAfter.getTime() + skewMs);
      const subject = `saml:${config.idp.entityId}:${assertion.id}`;
      if (!(await replay.claim(subject, replayStepFor(horizon), now))) {
        throw samlResponseInvalid(id, 'replay', 'this assertion was already consumed');
      }
      return identityOf(config, trusted, assertion);
    },
  };
  return Object.freeze(provider);
}
