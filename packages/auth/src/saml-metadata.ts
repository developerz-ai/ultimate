// Single responsibility: an IdP's SAML 2.0 metadata → its `entityID`, HTTP-Redirect sign-on URL
// and signing certificates. Parsed at boot, so a bad file fails the deploy, not the first login.
// The metadata is the operator's pinned trust anchor; its own signature is not checked here —
// fetch it over TLS, or paste it.

import { samlVerifyKey } from './saml-certificate';
import {
  attribute,
  BINDING_REDIRECT,
  childElements,
  DSIG_NS,
  descendants,
  isElement,
  MD_NS,
  textOf,
} from './saml-dom';
import { samlMetadataInvalid } from './saml-errors';
import { parseXml } from './saml-xml';

export interface SamlIdpMetadata {
  readonly entityId: string;
  /** The HTTP-Redirect SingleSignOnService location the AuthnRequest is sent to. */
  readonly ssoUrl: string;
  /** Base64 DER X.509 certificates. More than one during a key rollover: any of them verifies. */
  readonly certificates: readonly string[];
}

function signingCertificates(descriptor: Parameters<typeof childElements>[0]): string[] {
  const out: string[] = [];
  for (const key of childElements(descriptor, MD_NS, 'KeyDescriptor')) {
    const use = attribute(key, 'use');
    if (use !== undefined && use !== 'signing') continue;
    for (const node of descendants(key)) {
      if (!isElement(node, DSIG_NS, 'X509Certificate')) continue;
      const text = (textOf(node) ?? '').replace(/[ \t\n]+/g, '');
      if (text !== '' && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** Parse metadata, or throw `X_SAML_METADATA_INVALID` naming what is missing. */
export function parseSamlMetadata(xml: string): SamlIdpMetadata {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw samlMetadataInvalid(`it is not readable XML (${parsed.reason})`);
  const root = parsed.root;
  if (!isElement(root, MD_NS, 'EntityDescriptor')) {
    throw samlMetadataInvalid('the root is not one md:EntityDescriptor');
  }
  const entityId = attribute(root, 'entityID') ?? '';
  if (entityId === '') throw samlMetadataInvalid('the EntityDescriptor has no entityID');
  const descriptor = childElements(root, MD_NS, 'IDPSSODescriptor')[0];
  if (descriptor === undefined) {
    throw samlMetadataInvalid('there is no IDPSSODescriptor: this is not IdP metadata');
  }
  const sso = childElements(descriptor, MD_NS, 'SingleSignOnService').find(
    (service) => attribute(service, 'Binding') === BINDING_REDIRECT,
  );
  const ssoUrl = sso === undefined ? '' : (attribute(sso, 'Location') ?? '');
  if (!URL.canParse(ssoUrl)) {
    throw samlMetadataInvalid('no HTTP-Redirect SingleSignOnService carries a Location URL');
  }
  const certificates = signingCertificates(descriptor);
  if (certificates.length === 0) throw samlMetadataInvalid('no signing certificate is published');
  return Object.freeze({ entityId, ssoUrl, certificates: Object.freeze(certificates) });
}

/** The verification keys, once per provider. A certificate that yields no RSA-2048+ key refuses. */
export async function samlMetadataKeys(idp: SamlIdpMetadata): Promise<readonly CryptoKey[]> {
  const keys: CryptoKey[] = [];
  for (const certificate of idp.certificates) {
    const key = await samlVerifyKey(certificate);
    if (key === undefined) {
      throw samlMetadataInvalid('a signing certificate is unreadable, not RSA, or under 2048 bits');
    }
    keys.push(key);
  }
  if (keys.length === 0) throw samlMetadataInvalid('no signing certificate is published');
  return keys;
}
