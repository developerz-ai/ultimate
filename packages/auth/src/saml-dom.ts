// Single responsibility: reading a parsed SAML tree — the namespaces and algorithm URIs SAML
// speaks, and the four lookups every reader needs. Matched by namespace URI and local name, never
// by prefix: a prefix is the sender's choice, and matching `saml:` would let `evil:Assertion`
// bound to the same URI walk past a check, or `saml:` bound to another URI walk into one.

import type { XmlElement } from './saml-xml';

export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
export const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
export const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
export const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
export const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
export const NAMEID_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
export const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

export const isElement = (element: XmlElement, ns: string, local: string): boolean =>
  element.ns === ns && element.local === local;

export function childElements(element: XmlElement, ns?: string, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (child.kind !== 'element') continue;
    if (ns !== undefined && local !== undefined && !isElement(child, ns, local)) continue;
    out.push(child);
  }
  return out;
}

/** Every element below `element`, in document order, `element` excluded. */
export function descendants(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of childElements(node)) {
      out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

/** An unqualified attribute — SAML's own attributes are never namespaced. */
export function attribute(element: XmlElement, local: string): string | undefined {
  return element.attributes.find((one) => one.ns === '' && one.local === local)?.value;
}

/**
 * The element's text: EVERY text child, concatenated — what the signature covered, since c14n
 * drops comments. `undefined` when it holds an element, which no SAML leaf value does.
 */
export function textOf(element: XmlElement): string | undefined {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'element') return undefined;
    if (child.kind === 'text') text += child.value;
  }
  return text;
}
