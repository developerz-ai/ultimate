// Single responsibility: the SAML refusals. One code for every check a response can fail —
// `X_SAML_RESPONSE_INVALID` with the check in `meta.check` — because the operator needs to know
// WHICH check (an audience mismatch is the commonest setup bug there is) and the anonymous caller
// gets none of it: the route serves the code and its title only, like the OAuth legs.

import { renderCauseValue } from '@ultimat3/core';
import { AuthError } from './errors';

/** Every check a response is put through, in the order `verifySamlResponse` runs them. */
export type SamlCheck =
  | 'encoding'
  | 'xml'
  | 'structure'
  | 'id-duplicate'
  | 'encrypted'
  | 'signature-missing'
  | 'algorithm'
  | 'reference'
  | 'signature'
  | 'digest'
  | 'status'
  | 'issuer'
  | 'destination'
  | 'in-response-to'
  | 'recipient'
  | 'audience'
  | 'not-before'
  | 'expired'
  | 'subject'
  | 'relay-state'
  | 'replay';

const SP = 'samlIdentityProvider({ id, idp: parseSamlMetadata(xml), spEntityId, trustEmail })';
const IDP_APP = `${SP}  // unchanged here; in the IdP application:`;
const METADATA =
  "parseSamlMetadata(await Bun.file('idp-metadata.xml').text())  // the IdP current metadata";

/**
 * The repair per check. Each opens with the code to paste (`X_FIX_PROSE`): the SP side as a call,
 * an IdP-side setting as that call's trailing comment, a retry as the route to start again at.
 */
const FIXES: Readonly<Record<SamlCheck, string>> = {
  encoding:
    'identityProviderRoutes(auth, { providers }).acs  // mount as-is: SAMLResponse arrives base64 and is decoded once',
  xml: `${IDP_APP} send a plain SAML 2.0 Response, no DOCTYPE or processing instruction`,
  structure: `${IDP_APP} one samlp:Response holding exactly one saml:Assertion`,
  'id-duplicate':
    'oauthStartPath(id)  // start again here; a response carrying one ID twice is a wrapping attempt, never accepted',
  encrypted: `${IDP_APP} turn assertion encryption off (not supported)`,
  'signature-missing': `${IDP_APP} turn on "sign assertion" (a signed response alone is refused)`,
  algorithm: `${IDP_APP} RSA-SHA256 signatures, SHA-256 digests, exclusive c14n`,
  reference: `${IDP_APP} sign the assertion by its ID with the enveloped-signature transform`,
  signature: `${METADATA}, pasted into samlIdentityProvider({ idp }): its signing certificate has likely rotated`,
  digest:
    'oauthStartPath(id)  // start again; if it repeats, remove the proxy rewriting the POST body between the IdP and this app',
  status: `${IDP_APP} assign this user to the application (the IdP answer is in meta.status)`,
  issuer: `${METADATA}: its entityID must be the assertion Issuer`,
  destination: 'oauthCallbackPath(id)  // the IdP application ACS URL is APP_URL + this path',
  'in-response-to':
    'oauthStartPath(id)  // start the sign-in here, not from the IdP dashboard: IdP-initiated responses are refused',
  recipient: 'oauthCallbackPath(id)  // the IdP application ACS URL is APP_URL + this path',
  audience:
    'samlIdentityProvider({ spEntityId })  // equal to the audience (SP entity id) the IdP application names',
  'not-before':
    'samlIdentityProvider({ skewMs: 120_000 })  // or sync the server clock first: chronyc makestep',
  expired: 'oauthStartPath(id)  // sync the server clock (chronyc makestep), then start again here',
  subject: `${IDP_APP} NameID format persistent (or emailAddress)`,
  'relay-state': 'oauthStartPath(id)  // start again here, in the same browser',
  replay: 'oauthStartPath(id)  // start again here: an assertion is accepted once',
};

/**
 * Read as a `Map` (`proto-index`): the `Record` above is what makes a missing check a compile
 * error; the lookup never indexes a plain object.
 */
const FIX_BY_CHECK: ReadonlyMap<string, string> = new Map(Object.entries(FIXES));

export const samlResponseInvalid = (
  provider: string,
  check: SamlCheck,
  detail: string,
  meta: Readonly<Record<string, unknown>> = {},
): AuthError =>
  new AuthError({
    code: 'X_SAML_RESPONSE_INVALID',
    cause: `the ${renderCauseValue(provider)} SAML response failed its ${check} check: ${detail}`,
    fix: FIX_BY_CHECK.get(check) ?? FIXES.xml,
    meta: { ...meta, provider, check },
  });

export const samlMetadataInvalid = (detail: string): AuthError =>
  new AuthError({
    code: 'X_SAML_METADATA_INVALID',
    cause: `the SAML IdP metadata is unusable: ${detail}`,
    fix: `${METADATA} XML, whole, downloaded again from its federation metadata URL`,
  });
