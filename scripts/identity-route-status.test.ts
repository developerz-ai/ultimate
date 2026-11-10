// The pin under the codes only the SSO routes throw: `oauth-route-status.test.ts` holds every ROW of
// `OAUTH_ROUTE_STATUS` equal to http's `statusFor`, but a missing row answers the descriptor's 502
// standalone and its real status behind the pipeline. This asks that every SSO code IS a row, and
// agrees. Imports both tier-2 packages, which neither may do itself.

import { describe, expect, test } from 'bun:test';
import { OAUTH_ROUTE_STATUS } from '@ultimat3/auth';
import { statusFor } from '@ultimat3/http';

/** Every code `identityProviderRoutes` and the SAML adapter raise that OAuth never did. */
const SSO_CODES = [
  'X_SAML_RESPONSE_INVALID',
  'X_SAML_METADATA_INVALID',
  'X_IDENTITY_PROVIDER_UNKNOWN',
] as const;

describe('the sign-in descriptors and the HTTP status table, for the SSO codes', () => {
  test('every SSO code is a row of the descriptors table', () => {
    expect(SSO_CODES.filter((code) => !Object.hasOwn(OAUTH_ROUTE_STATUS, code))).toEqual([]);
  });

  test('and each row answers what statusFor answers', () => {
    const rows = SSO_CODES.map((code) => [code, OAUTH_ROUTE_STATUS[code], statusFor(code)]);
    expect(rows.filter(([, row, http]) => row !== http)).toEqual([]);
  });
});
