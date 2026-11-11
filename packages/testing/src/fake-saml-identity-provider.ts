// A fake SAML IdP for an app's sign-in tests, the SAML twin of `fakeIdentityProvider`: metadata to
// hand `samlIdentityProvider`, and a signed answer to the AuthnRequest an SP's redirect carries, as a
// chosen user. `tamper()` mints the refusals that matter. The signer is `@ultimat3/auth/saml-test-idp`'s
// — the one auth's own suites sign with — loaded on first use, so this barrel stays auth-free.

import type { Clock } from '@ultimat3/core';
import { assert, systemClock } from '@ultimat3/core';

export interface FakeSamlUser {
  /** The `NameID`: what `profile.providerAccountId` reads. */
  readonly nameId: string;
  /** The `email` attribute; `null` omits it. Defaults to none. */
  readonly email?: string | null | undefined;
  /** The `displayName` attribute; absent omits it. */
  readonly name?: string | undefined;
}

export interface FakeSamlTamper {
  /** The audience names another SP. */
  readonly wrongAudience?: boolean | undefined;
  /** The assertion's window closed an hour ago. */
  readonly expired?: boolean | undefined;
  /** No signature at either level. */
  readonly unsigned?: boolean | undefined;
  /** Signed by a key the metadata does not publish. */
  readonly wrongKey?: boolean | undefined;
}

export interface FakeSamlIdentityProviderInput {
  /** The SP's entity id — `samlIdentityProvider({ spEntityId })` — that each response is for. */
  readonly audience: string;
  readonly users: readonly FakeSamlUser[];
  readonly clock?: Clock | undefined;
}

export interface FakeSamlAuthnRequest {
  readonly id: string;
  readonly relayState: string;
  /** Where the SP asked the answer posted: its `AssertionConsumerServiceURL`. */
  readonly acsUrl: string;
  readonly xml: string;
}

export interface FakeSamlIdentityProvider {
  readonly entityId: string;
  /** `parseSamlMetadata(metadataXml)` is `samlIdentityProvider`'s `idp`. */
  readonly metadataXml: string;
  /** Who the next answer signs in as. Defaults to the first user. */
  signInAs(nameId: string): void;
  /** Applies to every answer after it; `tamper({})` restores honesty. */
  tamper(flags: FakeSamlTamper): void;
  /** The AuthnRequest on an SP's redirect `location`, inflated. */
  readAuthnRequest(location: string): FakeSamlAuthnRequest;
  /** The browser's POST back for the request on `location`: the ACS's form body. */
  answer(location: string): Promise<{ readonly SAMLResponse: string; readonly RelayState: string }>;
}

const HOUR_MS = 3_600_000;

export async function fakeSamlIdentityProvider(
  input: FakeSamlIdentityProviderInput,
): Promise<FakeSamlIdentityProvider> {
  assert(
    input.users.length > 0,
    'fakeSamlIdentityProvider was given no users',
    'pass users: [{ nameId, email }]',
  );
  const saml = await import('@ultimat3/auth/saml-test-idp');
  const [idp, rogue] = await Promise.all([saml.samlTestIdp(), saml.testRsaSigner()]);
  const users = new Map(input.users.map((user) => [user.nameId, user]));
  const clock = input.clock ?? systemClock;
  let current = input.users[0]?.nameId ?? '';
  let flags: FakeSamlTamper = {};

  const readAuthnRequest = (location: string): FakeSamlAuthnRequest => {
    const request = saml.readAuthnRequest(location);
    const acsUrl = /\bAssertionConsumerServiceURL="([^"]+)"/.exec(request.xml)?.[1] ?? '';
    return { ...request, acsUrl };
  };

  return {
    entityId: saml.TEST_IDP_ENTITY_ID,
    metadataXml: idp.metadataXml,
    signInAs(nameId) {
      assert(users.has(nameId), `fake SAML IdP has no user ${nameId}`, 'add it to users: [...]');
      current = nameId;
    },
    tamper(next) {
      flags = next;
    },
    readAuthnRequest,
    async answer(location) {
      const request = readAuthnRequest(location);
      const user = users.get(current);
      const now = clock.now();
      const xml = await idp.responseXml({
        requestId: request.id,
        acsUrl: request.acsUrl,
        audience: flags.wrongAudience === true ? `${input.audience}#other` : input.audience,
        now: flags.expired === true ? new Date(now.getTime() - HOUR_MS) : now,
        nameId: current,
        email: user?.email ?? null,
        name: user?.name ?? null,
        signAssertion: flags.unsigned !== true,
        ...(flags.wrongKey === true ? { signer: rogue } : {}),
      });
      return { SAMLResponse: saml.encodeResponse(xml), RelayState: request.relayState };
    },
  };
}
