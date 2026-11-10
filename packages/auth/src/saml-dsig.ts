// Single responsibility: verify the ONE enveloped XML-DSig signature that is a direct child of an
// element, over that element alone. Wrapping makes the verifier and the reader look at two nodes;
// here there is no lookup to fool — the caller hands in the node it will read, the Reference must
// name THAT node's ID, and the key comes from metadata, never from the document's KeyInfo.

import { exclusiveC14n } from './saml-c14n';
import { base64Bytes } from './saml-certificate';
import {
  attribute,
  childElements,
  DSIG_NS,
  ENVELOPED,
  EXC_C14N,
  isElement,
  RSA_SHA256,
  SHA256,
  textOf,
} from './saml-dom';
import type { SamlCheck } from './saml-errors';
import type { XmlElement } from './saml-xml';

export type DsigVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly check: SamlCheck; readonly detail: string };

const fail = (check: SamlCheck, detail: string): DsigVerdict => ({ ok: false, check, detail });

/** The ds:* element children, white space skipped; any other child is a refusal. */
function dsChildren(element: XmlElement): XmlElement[] | undefined {
  for (const child of element.children) {
    if (child.kind === 'text' && child.value.trim() !== '') return undefined;
    if (child.kind === 'element' && child.ns !== DSIG_NS) return undefined;
  }
  return childElements(element);
}

/** The algorithm, plus the `InclusiveNamespaces PrefixList` exc-c14n allows under it. */
function c14nPrefixes(method: XmlElement): readonly string[] | undefined {
  if (attribute(method, 'Algorithm') !== EXC_C14N) return undefined;
  const inner = childElements(method);
  if (inner.length === 0) return [];
  const only = inner[0];
  if (inner.length !== 1 || only === undefined || only.ns !== EXC_C14N) return undefined;
  if (only.local !== 'InclusiveNamespaces') return undefined;
  return (attribute(only, 'PrefixList') ?? '').split(/[ \t\n]+/).filter((p) => p !== '');
}

interface ReferenceShape {
  readonly prefixes: readonly string[];
  readonly digest: Uint8Array;
}

function readReference(reference: XmlElement, signed: XmlElement): ReferenceShape | DsigVerdict {
  const id = attribute(signed, 'ID');
  if (id === undefined || id === '') return fail('reference', 'the signed element carries no ID');
  if (attribute(reference, 'URI') !== `#${id}`) {
    return fail('reference', 'the Reference URI does not name the element it is enveloped in');
  }
  const parts = dsChildren(reference);
  const [transforms, method, value] = parts ?? [];
  if (
    parts?.length !== 3 ||
    transforms === undefined ||
    method === undefined ||
    value === undefined
  ) {
    return fail('reference', 'the Reference is not Transforms, DigestMethod, DigestValue');
  }
  if (!isElement(transforms, DSIG_NS, 'Transforms')) return fail('reference', 'no Transforms');
  // Exactly enveloped-signature then exc-c14n: an XPath or XSLT transform is how a signature is
  // made to cover a different node set than the one the reader reads.
  const steps = dsChildren(transforms) ?? [];
  const [first, second] = steps;
  if (steps.length !== 2 || first === undefined || second === undefined) {
    return fail('algorithm', 'the transforms are not enveloped-signature then exc-c14n');
  }
  const prefixes = c14nPrefixes(second);
  if (attribute(first, 'Algorithm') !== ENVELOPED || childElements(first).length > 0) {
    return fail('algorithm', 'the first transform is not enveloped-signature');
  }
  if (prefixes === undefined) return fail('algorithm', 'the second transform is not exc-c14n');
  if (!isElement(method, DSIG_NS, 'DigestMethod') || attribute(method, 'Algorithm') !== SHA256) {
    return fail('algorithm', 'the digest is not SHA-256');
  }
  const digest = isElement(value, DSIG_NS, 'DigestValue')
    ? base64Bytes(textOf(value) ?? '')
    : undefined;
  return digest === undefined
    ? fail('reference', 'the DigestValue is not base64')
    : { prefixes, digest };
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/**
 * Verify `signed`'s own enveloped signature against the metadata keys. `{ ok: false }` names the
 * check; `signature-missing` when the element carries none (the caller decides if that is fatal).
 */
export async function verifyEnvelopedSignature(
  signed: XmlElement,
  keys: readonly CryptoKey[],
): Promise<DsigVerdict> {
  const signatures = childElements(signed, DSIG_NS, 'Signature');
  const signature = signatures[0];
  if (signature === undefined) return fail('signature-missing', 'the element carries no signature');
  if (signatures.length > 1) return fail('structure', 'the element carries two signatures');
  // SignedInfo, SignatureValue, then an optional KeyInfo that is never read. A ds:Object is where
  // wrapping attacks hide the original assertion, so its presence alone is a refusal.
  const parts = dsChildren(signature) ?? [];
  const [signedInfo, signatureValue, keyInfo] = parts;
  if (
    signedInfo === undefined ||
    signatureValue === undefined ||
    !isElement(signedInfo, DSIG_NS, 'SignedInfo') ||
    !isElement(signatureValue, DSIG_NS, 'SignatureValue') ||
    parts.length > 3 ||
    (keyInfo !== undefined && !isElement(keyInfo, DSIG_NS, 'KeyInfo'))
  ) {
    return fail('structure', 'the Signature is not SignedInfo, SignatureValue[, KeyInfo]');
  }
  const info = dsChildren(signedInfo) ?? [];
  const [c14nMethod, signatureMethod, reference] = info;
  if (
    info.length !== 3 ||
    c14nMethod === undefined ||
    signatureMethod === undefined ||
    reference === undefined
  ) {
    return fail('reference', 'SignedInfo must hold exactly one Reference');
  }
  const infoPrefixes = isElement(c14nMethod, DSIG_NS, 'CanonicalizationMethod')
    ? c14nPrefixes(c14nMethod)
    : undefined;
  if (infoPrefixes === undefined) return fail('algorithm', 'SignedInfo is not exc-c14n');
  if (
    !isElement(signatureMethod, DSIG_NS, 'SignatureMethod') ||
    attribute(signatureMethod, 'Algorithm') !== RSA_SHA256 ||
    childElements(signatureMethod).length > 0
  ) {
    return fail('algorithm', 'the signature is not RSA-SHA256');
  }
  if (!isElement(reference, DSIG_NS, 'Reference')) return fail('reference', 'no Reference');
  const shape = readReference(reference, signed);
  if ('ok' in shape) return shape;

  const value = base64Bytes(textOf(signatureValue) ?? '');
  if (value === undefined) return fail('signature', 'the SignatureValue is not base64');
  const canonicalInfo = utf8(exclusiveC14n(signedInfo, { inclusivePrefixes: infoPrefixes }));
  let verified = false;
  for (const key of keys) {
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, value, canonicalInfo)) verified = true;
  }
  if (!verified) return fail('signature', 'no metadata certificate verifies the SignedInfo');

  const canonical = exclusiveC14n(signed, {
    exclude: signature,
    inclusivePrefixes: shape.prefixes,
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canonical)));
  if (!equalBytes(digest, shape.digest)) return fail('digest', 'the signed content was altered');
  return { ok: true };
}
