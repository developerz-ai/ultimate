// Hostile SAML responses: each is a published attack class against XML-DSig SPs (signature
// wrapping XSW1–XSW8, comment injection in NameID, unsigned assertion in a signed response, key
// substitution through KeyInfo, XXE / entity expansion), and each must be refused — or, for the
// comment, read as exactly what was signed.

import { describe, expect, test } from 'bun:test';
import { NAMEID_EMAIL } from './saml-dom';
import { samlTestIdp } from './saml-test-idp';
import { testRsaSigner } from './saml-test-signer';
import { refusalOf, samlHarness } from './saml-test-support-fixture';
import { SIGNED_MESSAGE_RESPONSE } from './saml-vectors-fixture';

const ASSERTION = /<saml:Assertion [\s\S]*<\/saml:Assertion>/;
const assertionOf = (xml: string): string =>
  ASSERTION.exec(xml)?.[0] ?? expect.unreachable('no assertion');
const INVALID = 'X_SAML_RESPONSE_INVALID';

describe('signature wrapping', () => {
  test('an evil assertion beside the signed one (XSW: two assertions) is refused', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml();
    const evil = assertionOf(await login.xml({ nameId: 'root', signAssertion: false }));
    const wrapped = signed.replace('<saml:Assertion ', `${evil}<saml:Assertion `);
    expect(await refusalOf(login.complete(wrapped))).toBe(`${INVALID}:structure`);
  });

  test('an evil assertion sharing the signed ID, so an ID lookup could pick either, is refused', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml({ assertionId: '_same' });
    const evil = assertionOf(
      await login.xml({ nameId: 'root', assertionId: '_same', signAssertion: false }),
    );
    const wrapped = signed.replace('<saml:Assertion ', `${evil}<saml:Assertion `);
    expect(await refusalOf(login.complete(wrapped))).toBe(`${INVALID}:id-duplicate`);
  });

  test('the signed assertion hidden in Extensions, an evil one in its place, is refused', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml();
    const original = assertionOf(signed);
    const evil = assertionOf(await login.xml({ nameId: 'root', signAssertion: false }));
    const wrapped = signed.replace(
      original,
      `<samlp:Extensions>${original}</samlp:Extensions>${evil}`,
    );
    expect(await refusalOf(login.complete(wrapped))).toBe(`${INVALID}:structure`);
  });

  test('an evil assertion carrying the original signature (reference names another ID) is refused', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml();
    const signature = /<ds:Signature [\s\S]*<\/ds:Signature>/.exec(signed)?.[0] ?? '';
    const evil = assertionOf(await login.xml({ nameId: 'root', signAssertion: false })).replace(
      '</saml:Issuer>',
      `</saml:Issuer>${signature}`,
    );
    const wrapped = signed.replace(assertionOf(signed), evil);
    expect(await refusalOf(login.complete(wrapped))).toBe(`${INVALID}:reference`);
  });

  test('an evil assertion re-using the signed ID and signature fails the digest', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml({ assertionId: '_fixed' });
    const forged = signed.replace('>u-1001<', '>root<');
    expect(await refusalOf(login.complete(forged))).toBe(`${INVALID}:digest`);
  });

  test('a ds:Object inside the signature, where wrapping hides the original, is refused', async () => {
    const login = await (await samlHarness()).begin();
    const signed = await login.xml();
    const stuffed = signed.replace('</ds:KeyInfo>', '</ds:KeyInfo><ds:Object></ds:Object>');
    expect(await refusalOf(login.complete(stuffed))).toBe(`${INVALID}:structure`);
  });
});

describe('comment injection', () => {
  test('a comment inside a signed NameID is read as the whole signed value, never its prefix', async () => {
    const login = await (await samlHarness()).begin();
    // The IdP signed `ada@corp.example.evil.test`; the attacker adds a comment after the real
    // victim's address. The signature still verifies (c14n drops comments) — the reader must too.
    const signed = await login.xml({
      nameId: 'ada@corp.example.evil.test',
      nameIdFormat: NAMEID_EMAIL,
    });
    const injected = signed.replace(
      '>ada@corp.example.evil.test<',
      '>ada@corp.example<!---->.evil.test<',
    );
    const identity = await login.complete(injected);
    expect(identity.profile.providerAccountId).toBe('ada@corp.example.evil.test');
  });
});

describe('unsigned assertions', () => {
  test('an unsigned assertion inside a signed response is refused', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({ signAssertion: false, signResponse: true });
    expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:signature-missing`);
  });

  test('a real xmlsec RSA-SHA1 signed message is refused on its algorithm', async () => {
    const login = await (await samlHarness()).begin();
    expect(await refusalOf(login.complete(SIGNED_MESSAGE_RESPONSE))).toBe(`${INVALID}:algorithm`);
  });

  test('a fully unsigned response is refused', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({ signAssertion: false });
    expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:signature-missing`);
  });
});

describe('keys', () => {
  test('an assertion signed by another key — its own certificate in KeyInfo — is refused', async () => {
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({ signer: await testRsaSigner() });
    expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:signature`);
  });

  test('an IdP that rotated its key fails until the new metadata is pasted', async () => {
    const rotated = await samlTestIdp();
    const login = await (await samlHarness()).begin();
    const xml = await login.xml({ signer: rotated.signer });
    expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:signature`);
  });
});

describe('the reader refuses what SAML never needs', () => {
  const documents = [
    ['an internal entity (billion laughs)', '<!DOCTYPE r [<!ENTITY a "aaaa">]><r>&a;</r>'],
    [
      'an external entity (XXE)',
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
    ],
    ['a processing instruction', '<?xml-stylesheet href="x"?><r/>'],
    ['an undeclared prefix', '<samlp:Response/>'],
    ['two roots', '<r/><r/>'],
    [
      'a namespace-declaration bomb (K declarations × N elements)',
      `<r${Array.from({ length: 8000 }, (_, i) => ` xmlns:p${i}="u"`).join('')}>${'<a xmlns:b="u"/>'.repeat(8000)}</r>`,
    ],
  ] as const;
  for (const [name, xml] of documents) {
    test(`refused: ${name}`, async () => {
      const login = await (await samlHarness()).begin();
      expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:xml`);
    });
  }

  test('refused: an encrypted assertion', async () => {
    const login = await (await samlHarness()).begin();
    const xml = (await login.xml()).replace(
      '</samlp:Status>',
      '</samlp:Status><saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"></saml:EncryptedAssertion>',
    );
    expect(await refusalOf(login.complete(xml))).toBe(`${INVALID}:encrypted`);
  });
});
