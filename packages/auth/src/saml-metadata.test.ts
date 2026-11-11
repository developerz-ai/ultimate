// IdP metadata → entity id, redirect SSO URL, signing certificates; and the refusals that make a
// bad file fail at boot instead of at the first login.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { parseSamlMetadata, samlMetadataKeys } from './saml-metadata';
import { samlTestIdp, TEST_IDP_ENTITY_ID, TEST_IDP_SSO_URL } from './saml-test-idp';
import { VECTOR_CERTIFICATE } from './saml-vectors-fixture';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
  return 'accepted';
};

describe('parseSamlMetadata', () => {
  test('reads the entity id, the HTTP-Redirect endpoint and the signing certificate', async () => {
    const idp = await samlTestIdp();
    expect(idp.idp).toEqual({
      entityId: TEST_IDP_ENTITY_ID,
      ssoUrl: TEST_IDP_SSO_URL,
      certificates: [idp.signer.certificate],
    });
    expect(await samlMetadataKeys(idp.idp)).toHaveLength(1);
  });

  test('an encryption-only key is not a signing key', async () => {
    const idp = await samlTestIdp();
    const xml = idp.metadataXml.replace('use="signing"', 'use="encryption"');
    expect(codeOf(() => parseSamlMetadata(xml))).toBe('X_SAML_METADATA_INVALID');
  });

  const broken = [
    ['not XML', 'nope'],
    [
      'SP metadata',
      '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><md:SPSSODescriptor/></md:EntityDescriptor>',
    ],
    ['no entityID', '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/>'],
  ] as const;
  for (const [name, xml] of broken) {
    test(`refused: ${name}`, () => {
      expect(codeOf(() => parseSamlMetadata(xml))).toBe('X_SAML_METADATA_INVALID');
    });
  }

  test('refused: only an HTTP-POST sign-on endpoint', async () => {
    const idp = await samlTestIdp();
    const xml = idp.metadataXml.replace(
      /<md:SingleSignOnService Binding="[^"]*HTTP-Redirect"[^>]*\/>/,
      '',
    );
    expect(codeOf(() => parseSamlMetadata(xml))).toBe('X_SAML_METADATA_INVALID');
  });

  test('refused at key import: an RSA-1024 certificate', async () => {
    const idp = { entityId: 'x', ssoUrl: 'https://x.test', certificates: [VECTOR_CERTIFICATE] };
    const verdict = await samlMetadataKeys(idp).then(
      () => 'accepted',
      (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
    );
    expect(verdict).toBe('X_SAML_METADATA_INVALID');
  });
});
