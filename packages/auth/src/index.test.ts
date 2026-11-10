// The public surface this package's README promises. A name the README documents and `index.ts`
// does not re-export is a call an app cannot make — the failure this file exists to catch.

import { describe, expect, test } from 'bun:test';
import * as auth from './index';
import { BUILTIN_OAUTH_PROVIDER_IDS as declared } from './oauth-builtins';

describe('@ultimat3/auth public surface', () => {
  test('re-exports `BUILTIN_OAUTH_PROVIDER_IDS`, the list README.md tells an app to read', () => {
    expect(auth.BUILTIN_OAUTH_PROVIDER_IDS).toBe(declared);
  });

  // Apple left the built-ins in 26.0.0 (#709): it POSTs its callback, and both callback routes are
  // GET, so it could never complete a sign-in. An app that wants it registers its own.
  test('it is the two shipped ids, frozen — apple is not one of them', () => {
    expect([...auth.BUILTIN_OAUTH_PROVIDER_IDS]).toEqual(['github', 'google']);
    expect('APPLE_PROVIDER' in auth).toBe(false);
    expect(Object.isFrozen(auth.BUILTIN_OAUTH_PROVIDER_IDS)).toBe(true);
  });

  test('v31: the app API only — no error factory, code list, schema or internal default', () => {
    const internal = [
      'API_KEY_NAMESPACE',
      'AUTH_CODE_TTL_MS',
      'AUTH_ERROR_CODES',
      'AUTH_ERROR_TITLES',
      'AUTH_SERVER_METADATA_WELL_KNOWN',
      'AUTH_SUBJECT_COLUMNS',
      'AccountSchema',
      'DEFAULT_MFA_ISSUER',
      'DEFAULT_PASSKEY_CHALLENGE_TTL_MS',
      'DEFAULT_PASSWORD_PARAMS',
      'DEFAULT_SAML_EMAIL_ATTRIBUTES',
      'DEFAULT_SAML_NAME_ATTRIBUTES',
      'DEFAULT_SAML_SKEW_MS',
      'SessionSchema',
      'UserSchema',
      'VerificationSchema',
      'authLimiterNotShared',
      'authLimiterPolicyMismatch',
      'decodeIdToken',
      'idTokenEmailVerified',
      'listDevices',
      'mfaRequiredUnenforceable',
      'mfaSecretInvalid',
      'mfaSecretUnsealed',
      'oauthAccountNotLinked',
      'oauthLinkingDisabled',
      'oauthProviderDuplicate',
      'oauthStateInvalid',
      'oauthTokenInvalid',
      'verificationPurposeNames',
    ];
    expect(internal.filter((name) => name in auth)).toEqual([]);
  });

  test('both built-in providers and the TOTP parameters README.md documents stay', () => {
    for (const name of [
      'GITHUB_PROVIDER',
      'GOOGLE_PROVIDER',
      'TOTP_DIGITS',
      'TOTP_DRIFT_STEPS',
      'TOTP_STEP_SECONDS',
    ]) {
      expect(name in auth).toBe(true);
    }
  });
});
