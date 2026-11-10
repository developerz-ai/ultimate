// Single responsibility: the SP-initiated leg — an AuthnRequest, DEFLATEd and base64'd onto the
// IdP's HTTP-Redirect endpoint with a RelayState (SAML Bindings §3.4). Unsigned: the response is
// what is verified, and the request's ID comes back as InResponseTo, which is the binding that
// matters. The ID and RelayState are random and returned so the caller can seal them.

import { type Clock, escapeHtml } from '@ultimat3/core';
import { BINDING_POST, NAMEID_PERSISTENT, SAML_NS, SAMLP_NS } from './saml-dom';
import type { SamlIdpMetadata } from './saml-metadata';
import { randomToken } from './tokens';

export interface SamlAuthnRequestInput {
  readonly idp: SamlIdpMetadata;
  readonly spEntityId: string;
  /** Where the IdP POSTs the response: the callback route for this provider. */
  readonly acsUrl: string;
  readonly clock: Clock;
  readonly nameIdFormat?: string | undefined;
}

export interface SamlAuthnRequest {
  /** `ID` of the request; the response must answer it as `InResponseTo`. */
  readonly id: string;
  /** Echoed by the IdP; ≤ 80 bytes as Bindings §3.4.3 requires. */
  readonly relayState: string;
  readonly xml: string;
  /** The IdP URL to redirect the browser to. */
  readonly location: string;
}

/** IssueInstant is UTC by definition (SAML Core §1.3.3), without milliseconds. */
const instant = (at: Date): string => `${at.toISOString().slice(0, 19)}Z`;

export function samlAuthnRequest(input: SamlAuthnRequestInput): SamlAuthnRequest {
  // `_` first: an xs:ID is an NCName, which may not start with a digit; base64url is NCName-safe.
  const id = `_${randomToken(20)}`;
  const relayState = randomToken(24);
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}"` +
    ` ID="${id}" Version="2.0" IssueInstant="${instant(input.clock.now())}"` +
    ` Destination="${escapeHtml(input.idp.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${escapeHtml(input.acsUrl)}"` +
    ` ProtocolBinding="${BINDING_POST}">` +
    `<saml:Issuer>${escapeHtml(input.spEntityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${escapeHtml(input.nameIdFormat ?? NAMEID_PERSISTENT)}" AllowCreate="true"/>` +
    '</samlp:AuthnRequest>';
  const deflated = Bun.deflateSync(new TextEncoder().encode(xml));
  const url = new URL(input.idp.ssoUrl);
  url.searchParams.set('SAMLRequest', btoa(String.fromCharCode(...deflated)));
  url.searchParams.set('RelayState', relayState);
  return { id, relayState, xml, location: url.toString() };
}
