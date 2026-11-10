// Single responsibility: a posted SAMLResponse → one verified `SamlAssertion`, or
// `X_SAML_RESPONSE_INVALID` naming the check. The shape is pinned before any signature — one
// Response, ONE Assertion in the document as its direct child, no ID twice, nothing encrypted —
// and the assertion's OWN signature is required; a response signature, if present, must verify.

import {
  type AssertionExpectations,
  AssertionRefusal,
  readAssertion,
  type SamlAssertion,
} from './saml-assertion';
import { base64Bytes } from './saml-certificate';
import {
  attribute,
  childElements,
  descendants,
  isElement,
  SAML_NS,
  SAMLP_NS,
  STATUS_SUCCESS,
  textOf,
} from './saml-dom';
import { verifyEnvelopedSignature } from './saml-dsig';
import { samlResponseInvalid } from './saml-errors';
import { parseXml, type XmlElement } from './saml-xml';

export interface SamlResponseExpectations extends Omit<AssertionExpectations, 'issuer'> {
  /** The provider id, for the refusal. */
  readonly provider: string;
  readonly idpEntityId: string;
  readonly keys: readonly CryptoKey[];
}

function decodeResponse(provider: string, posted: string): XmlElement {
  const bytes = base64Bytes(posted);
  if (bytes === undefined)
    throw samlResponseInvalid(provider, 'encoding', 'SAMLResponse is not base64');
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw samlResponseInvalid(provider, 'encoding', 'SAMLResponse is not UTF-8');
  }
  const parsed = parseXml(xml);
  if (!parsed.ok)
    throw samlResponseInvalid(provider, 'xml', 'the document was refused by the reader');
  return parsed.root;
}

/** The one assertion, after every structural refusal a wrapping attack would need to survive. */
function soleAssertion(provider: string, response: XmlElement): XmlElement {
  if (!isElement(response, SAMLP_NS, 'Response')) {
    throw samlResponseInvalid(provider, 'structure', 'the root is not samlp:Response');
  }
  const all = descendants(response);
  const ids = new Set<string>();
  for (const element of [response, ...all]) {
    const id = attribute(element, 'ID');
    if (id === undefined) continue;
    if (ids.has(id))
      throw samlResponseInvalid(provider, 'id-duplicate', 'two elements share one ID');
    ids.add(id);
  }
  if (all.some((el) => el.local === 'EncryptedAssertion' || el.local === 'EncryptedID')) {
    throw samlResponseInvalid(provider, 'encrypted', 'encrypted assertions are not supported');
  }
  const assertions = all.filter((el) => isElement(el, SAML_NS, 'Assertion'));
  const assertion = assertions[0];
  if (assertions.length !== 1 || assertion === undefined || assertion.parent !== response) {
    throw samlResponseInvalid(
      provider,
      'structure',
      'the response must hold exactly one assertion, directly',
    );
  }
  return assertion;
}

function responseHeader(
  provider: string,
  response: XmlElement,
  expect: SamlResponseExpectations,
): void {
  const status = childElements(response, SAMLP_NS, 'Status')[0];
  const code = status === undefined ? undefined : childElements(status, SAMLP_NS, 'StatusCode')[0];
  const value = code === undefined ? undefined : attribute(code, 'Value');
  if (value !== STATUS_SUCCESS) {
    throw samlResponseInvalid(provider, 'status', 'the IdP did not answer Success', {
      status: value ?? null,
    });
  }
  const destination = attribute(response, 'Destination');
  if (destination !== undefined && destination !== expect.recipient) {
    throw samlResponseInvalid(provider, 'destination', 'the Destination is not this ACS URL');
  }
  const inResponseTo = attribute(response, 'InResponseTo');
  if (inResponseTo !== expect.requestId) {
    throw samlResponseInvalid(provider, 'in-response-to', 'the response answers another request');
  }
  const issuer = childElements(response, SAML_NS, 'Issuer')[0];
  if (issuer !== undefined && textOf(issuer) !== expect.idpEntityId) {
    throw samlResponseInvalid(
      provider,
      'issuer',
      'the response Issuer is not the metadata entityID',
    );
  }
}

export async function verifySamlResponse(
  posted: string,
  expect: SamlResponseExpectations,
): Promise<SamlAssertion> {
  const { provider, keys } = expect;
  const response = decodeResponse(provider, posted);
  const assertion = soleAssertion(provider, response);
  const outer = await verifyEnvelopedSignature(response, keys);
  if (!outer.ok && outer.check !== 'signature-missing') {
    throw samlResponseInvalid(provider, outer.check, `response: ${outer.detail}`);
  }
  const inner = await verifyEnvelopedSignature(assertion, keys);
  if (!inner.ok) throw samlResponseInvalid(provider, inner.check, `assertion: ${inner.detail}`);
  responseHeader(provider, response, expect);
  try {
    return readAssertion(assertion, { ...expect, issuer: expect.idpEntityId });
  } catch (error) {
    if (error instanceof AssertionRefusal)
      throw samlResponseInvalid(provider, error.check, error.detail);
    throw error;
  }
}
