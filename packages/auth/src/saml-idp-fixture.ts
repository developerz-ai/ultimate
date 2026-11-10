// TEST-ONLY. A SAML IdP in-process: metadata, and signed responses written DIRECTLY in canonical
// form — every namespace declared where exc-c14n renders it, attributes pre-sorted, no empty-tag
// shorthand — so the digest is SHA-256 of the literal string and the signer never calls the
// `saml-c14n.ts` it is testing. `@ultimat3/testing`'s IdentityProvider conformance drives it too.

import { c14nAttribute, c14nText } from './saml-c14n';
import { type TestRsaSigner, testRsaSigner } from './saml-cert-fixture';
import {
  BEARER,
  DSIG_NS,
  ENVELOPED,
  EXC_C14N,
  MD_NS,
  NAMEID_PERSISTENT,
  RSA_SHA256,
  SAML_NS,
  SAMLP_NS,
  SHA256,
  STATUS_SUCCESS,
} from './saml-dom';
import { parseSamlMetadata, type SamlIdpMetadata } from './saml-metadata';

export const TEST_IDP_ENTITY_ID = 'https://idp.example.test/metadata';
export const TEST_IDP_SSO_URL = 'https://idp.example.test/sso';

export interface TestResponseSpec {
  readonly requestId: string;
  readonly acsUrl: string;
  readonly audience: string;
  readonly now: Date;
  readonly nameId?: string;
  readonly nameIdFormat?: string;
  /** `null` omits the email attribute. */
  readonly email?: string | null;
  /** The confirmation's Recipient alone; default `acsUrl`. */
  readonly recipient?: string;
  readonly issuer?: string;
  readonly assertionId?: string;
  readonly lifetimeMs?: number;
  readonly notBefore?: Date;
  readonly status?: string;
  readonly signAssertion?: boolean;
  readonly signResponse?: boolean;
  readonly signer?: TestRsaSigner;
  readonly digestAlgorithm?: string;
}

export interface TestIdp {
  readonly signer: TestRsaSigner;
  readonly metadataXml: string;
  readonly idp: SamlIdpMetadata;
  /** The response document, in canonical form. Tamper with it, then `encode` it. */
  responseXml(spec: TestResponseSpec): Promise<string>;
  respond(spec: TestResponseSpec): Promise<string>;
}

export const encodeResponse = (xml: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(xml)));

/** Text and attribute values in canonical form: the spec's tables, shared with the verifier. */
const esc = c14nText;
const escAttr = c14nAttribute;
const at = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const randomId = (): string => `_${crypto.randomUUID().replaceAll('-', '')}`;

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** `<ds:Signature>` for the canonical `signed` (which carries ID `id`), in canonical form. */
async function signatureFor(signed: string, id: string, signer: TestRsaSigner, digestAlg: string) {
  const body =
    `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${RSA_SHA256}"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${id}"><ds:Transforms>` +
    `<ds:Transform Algorithm="${ENVELOPED}"></ds:Transform>` +
    `<ds:Transform Algorithm="${EXC_C14N}"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${digestAlg}"></ds:DigestMethod>` +
    `<ds:DigestValue>${await sha256Base64(signed)}</ds:DigestValue></ds:Reference>`;
  const value = await signer.sign(`<ds:SignedInfo xmlns:ds="${DSIG_NS}">${body}</ds:SignedInfo>`);
  return (
    `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>${body}</ds:SignedInfo>` +
    `<ds:SignatureValue>${value}</ds:SignatureValue><ds:KeyInfo><ds:X509Data>` +
    `<ds:X509Certificate>${signer.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`
  );
}

/** Splice the signature in right after the element's first `</saml:Issuer>`. */
const envelop = (canonical: string, signature: string): string =>
  canonical.replace('</saml:Issuer>', `</saml:Issuer>${signature}`);

function assertionXml(spec: TestResponseSpec, id: string): string {
  const notOnOrAfter = at(new Date(spec.now.getTime() + (spec.lifetimeMs ?? 300_000)));
  const notBefore = at(spec.notBefore ?? new Date(spec.now.getTime() - 30_000));
  const email = spec.email === undefined ? 'ada@corp.example' : spec.email;
  const emailAttribute =
    email === null
      ? ''
      : `<saml:Attribute Name="email"><saml:AttributeValue>${esc(email)}</saml:AttributeValue></saml:Attribute>`;
  return (
    `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${id}" IssueInstant="${at(spec.now)}" Version="2.0">` +
    `<saml:Issuer>${esc(spec.issuer ?? TEST_IDP_ENTITY_ID)}</saml:Issuer><saml:Subject>` +
    `<saml:NameID Format="${spec.nameIdFormat ?? NAMEID_PERSISTENT}">${esc(spec.nameId ?? 'u-1001')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${BEARER}"><saml:SubjectConfirmationData InResponseTo="${escAttr(spec.requestId)}"` +
    ` NotOnOrAfter="${notOnOrAfter}" Recipient="${escAttr(spec.recipient ?? spec.acsUrl)}"></saml:SubjectConfirmationData>` +
    `</saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${esc(spec.audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions><saml:AuthnStatement AuthnInstant="${at(spec.now)}" SessionIndex="s-1">` +
    '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password' +
    '</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>' +
    emailAttribute +
    '<saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute>' +
    '</saml:AttributeStatement></saml:Assertion>'
  );
}

export async function samlTestIdp(signer?: TestRsaSigner): Promise<TestIdp> {
  const own = signer ?? (await testRsaSigner());
  const metadataXml =
    `<md:EntityDescriptor xmlns:md="${MD_NS}" xmlns:ds="${DSIG_NS}" entityID="${TEST_IDP_ENTITY_ID}">` +
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">' +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>\n${own.certificate}\n` +
    '</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>' +
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/post"/>' +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${TEST_IDP_SSO_URL}"/>` +
    '</md:IDPSSODescriptor></md:EntityDescriptor>';

  const responseXml = async (spec: TestResponseSpec): Promise<string> => {
    const key = spec.signer ?? own;
    const digestAlg = spec.digestAlgorithm ?? SHA256;
    const assertionId = spec.assertionId ?? randomId();
    let assertion = assertionXml(spec, assertionId);
    if (spec.signAssertion ?? true) {
      assertion = envelop(assertion, await signatureFor(assertion, assertionId, key, digestAlg));
    }
    // Inside the response, the saml prefix is already rendered by... nobody: Response does not
    // use it, so exc-c14n renders it on the Issuer and the Assertion — exactly as written here.
    const id = randomId();
    const response =
      `<samlp:Response xmlns:samlp="${SAMLP_NS}" Destination="${escAttr(spec.acsUrl)}" ID="${id}"` +
      ` InResponseTo="${escAttr(spec.requestId)}" IssueInstant="${at(spec.now)}" Version="2.0">` +
      `<saml:Issuer xmlns:saml="${SAML_NS}">${esc(spec.issuer ?? TEST_IDP_ENTITY_ID)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="${spec.status ?? STATUS_SUCCESS}"></samlp:StatusCode></samlp:Status>` +
      `${assertion}</samlp:Response>`;
    return spec.signResponse === true
      ? envelop(response, await signatureFor(response, id, key, digestAlg))
      : response;
  };

  return {
    signer: own,
    metadataXml,
    idp: parseSamlMetadata(metadataXml),
    responseXml,
    respond: async (spec) => encodeResponse(await responseXml(spec)),
  };
}

/** What `samlAuthnRequest` put on the redirect: inflated, so a test can answer it. */
export function readAuthnRequest(location: string): {
  id: string;
  relayState: string;
  xml: string;
} {
  const url = new URL(location);
  const deflated = Uint8Array.from(atob(url.searchParams.get('SAMLRequest') ?? ''), (c) =>
    c.charCodeAt(0),
  );
  const xml = new TextDecoder().decode(Bun.inflateSync(deflated));
  const id = /\bID="([^"]+)"/.exec(xml)?.[1] ?? '';
  return { id, relayState: url.searchParams.get('RelayState') ?? '', xml };
}
