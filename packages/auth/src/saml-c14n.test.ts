// Exclusive c14n, proven against bytes another implementation signed: every DigestValue in the
// three xmlsec-signed vectors must come out of our canonical form, and every SignedInfo must
// verify under the vector's certificate. SHA-1 here is the vectors' algorithm, never production's.

import { describe, expect, test } from 'bun:test';
import { exclusiveC14n } from './saml-c14n';
import { base64Bytes, certificateSpki } from './saml-certificate';
import { childElements, DSIG_NS, descendants } from './saml-dom';
import {
  DOUBLE_SIGNED_RESPONSE,
  SIGNED_ASSERTION_RESPONSE,
  SIGNED_MESSAGE_RESPONSE,
  VECTOR_CERTIFICATE,
} from './saml-vectors-fixture';
import { parseXml, type XmlElement } from './saml-xml';

const parsed = (xml: string): XmlElement => {
  const result = parseXml(xml);
  if (!result.ok) return expect.unreachable(result.reason);
  return result.root;
};

const signaturesIn = (root: XmlElement): XmlElement[] =>
  [root, ...descendants(root)].filter((el) => el.ns === DSIG_NS && el.local === 'Signature');

const child = (element: XmlElement, local: string): XmlElement => {
  const found = childElements(element, DSIG_NS, local)[0];
  return found ?? expect.unreachable(`no ds:${local}`);
};

const text = (element: XmlElement): string =>
  element.children.map((node) => (node.kind === 'text' ? node.value : '')).join('');

async function sha1Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

const VECTORS = [
  ['signed assertion', SIGNED_ASSERTION_RESPONSE, 1],
  ['signed message', SIGNED_MESSAGE_RESPONSE, 1],
  ['double signed', DOUBLE_SIGNED_RESPONSE, 2],
] as const;

describe('exclusive c14n against xmlsec-signed vectors', () => {
  for (const [name, xml, count] of VECTORS) {
    test(`${name}: every reference digest matches`, async () => {
      const signatures = signaturesIn(parsed(xml));
      expect(signatures).toHaveLength(count);
      for (const signature of signatures) {
        const signed = signature.parent ?? expect.unreachable('a detached signature');
        const reference = child(child(signature, 'SignedInfo'), 'Reference');
        const canonical = exclusiveC14n(signed, { exclude: signature });
        expect(await sha1Base64(canonical)).toBe(text(child(reference, 'DigestValue')).trim());
      }
    });

    test(`${name}: every SignedInfo verifies under the vector certificate`, async () => {
      const spki = certificateSpki(VECTOR_CERTIFICATE) ?? expect.unreachable('no spki');
      const key = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
        false,
        ['verify'],
      );
      for (const signature of signaturesIn(parsed(xml))) {
        const signedInfo = exclusiveC14n(child(signature, 'SignedInfo'));
        const value = base64Bytes(text(child(signature, 'SignatureValue'))) ?? new Uint8Array();
        const bytes = new TextEncoder().encode(signedInfo);
        expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, value, bytes)).toBe(true);
      }
    });
  }
});

describe('exclusive c14n rules', () => {
  const canonical = (xml: string, prefixes?: readonly string[]): string => {
    const root = parsed(xml);
    const apex = childElements(root)[0] ?? root;
    return exclusiveC14n(apex, { inclusivePrefixes: prefixes });
  };

  test('an ancestor namespace is rendered only where visibly used', () => {
    const xml = '<r xmlns:a="urn:a" xmlns:b="urn:b"><a:x b:k="1" z="2"/></r>';
    expect(canonical(xml)).toBe('<a:x xmlns:a="urn:a" xmlns:b="urn:b" z="2" b:k="1"></a:x>');
  });

  test('an unused namespace is dropped unless the InclusiveNamespaces list names it', () => {
    const xml = '<r xmlns:xs="urn:xs"><x t="xs:string"/></r>';
    expect(canonical(xml)).toBe('<x t="xs:string"></x>');
    expect(canonical(xml, ['xs'])).toBe('<x xmlns:xs="urn:xs" t="xs:string"></x>');
  });

  test('comments are dropped, text and attributes escaped, empty elements opened and closed', () => {
    const xml = '<r><x a="&quot;&#9;&lt;">a<!-- c -->b &amp; &gt;&#13;<y/></x></r>';
    expect(canonical(xml)).toBe('<x a="&quot;&#x9;&lt;">ab &amp; &gt;&#xD;<y></y></x>');
  });

  test('a default namespace is undeclared below an ancestor that rendered one', () => {
    const xml = '<r><x xmlns="urn:d"><y xmlns=""/></x></r>';
    expect(canonical(xml)).toBe('<x xmlns="urn:d"><y xmlns=""></y></x>');
  });
});
