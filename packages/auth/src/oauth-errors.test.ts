/**
 * What the `errors.ts` → `oauth-errors.ts` split must never change: each OAuth factory's stable
 * code, and the fact that importing this module registers the titles for them.
 *
 * It imports `./oauth-errors` and nothing else from this package, deliberately. The one
 * `registerErrorCodes()` call lives in `errors.ts`, and this file reaches it only through
 * `oauth-errors.ts`'s own import — so a later edit that drops that edge (a locally declared error
 * class, a type-only import) leaves every code below unregistered, and `x errors explain` answers
 * a humanised guess instead of the title the package owns. Importing `./errors` here would hide
 * exactly that, because the registration would then run for the test rather than for the subject.
 */

import { describe, expect, test } from 'bun:test';
import { hasErrorCode } from '@ultimat3/core';
import {
  emailVerifiedNotStored,
  oauthAccountNotLinked,
  oauthDenied,
  oauthExchangeFailed,
  oauthLinkingDisabled,
  oauthProviderDuplicate,
  oauthProviderUnknown,
  oauthStateInvalid,
  oauthTokenInvalid,
  restartAt,
} from './oauth-errors';

/** Every factory the split moved, against the code it has always carried. Codes are forever. */
const BUILT = [
  ['X_OAUTH_STATE_INVALID', () => oauthStateInvalid('github', 'state')],
  ['X_OAUTH_DENIED', () => oauthDenied('github', 'access_denied', null)],
  ['X_OAUTH_PROVIDER_UNKNOWN', () => oauthProviderUnknown('nope', ['github'])],
  ['X_OAUTH_PROVIDER_DUPLICATE', () => oauthProviderDuplicate('github')],
  [
    'X_OAUTH_EXCHANGE_FAILED',
    () =>
      oauthExchangeFailed({
        provider: 'github',
        stage: 'token',
        detail: 'bad secret',
        fix: 'set GITHUB_CLIENT_SECRET',
      }),
  ],
  ['X_UNAUTHENTICATED', () => oauthAccountNotLinked('github', 'a@example.com')],
  ['X_UNAUTHENTICATED', () => oauthLinkingDisabled('github', 'a@example.com')],
  ['X_NOT_IMPLEMENTED', () => emailVerifiedNotStored('github', 'user-1')],
  ['X_OAUTH_TOKEN_INVALID', () => oauthTokenInvalid('github', 'wrong iss', 'fix the issuer')],
] as const;

describe('the oauth error factories survive the split', () => {
  for (const [code, build] of BUILT) {
    test(`${code} is built by a factory that still answers with it`, () => {
      const error = build();
      expect(error.code).toBe(code);
      expect(error.name).toBe('AuthError');
      expect(error.cause).not.toBe('');
      expect(error.fix).not.toBe('');
    });
  }

  test('every code they carry is registered by importing this module alone', () => {
    // `describeErrorCode` would answer a humanised fallback for an unregistered code, so this asks
    // the registry directly: `hasErrorCode` is false for a code nothing registered.
    for (const [code] of BUILT) {
      expect(hasErrorCode(code), `${code} is not registered`).toBe(true);
    }
  });

  test('restartAt still quotes the mounted start path, never a hand-written one', () => {
    // The whole reason this phrase is a function: the fix line named a route the package did not
    // mount, and every caller who followed it got a 404.
    expect(restartAt('github')).toContain('/auth/oauth/github');
    expect(oauthStateInvalid('github', 'nonce').fix).toContain(restartAt('github'));
  });

  test('an address a provider handed back rides in meta, never in the sentence', () => {
    // A log pipeline redacts by key; it cannot redact an address already interpolated into prose.
    for (const build of [oauthAccountNotLinked, oauthLinkingDisabled]) {
      const error = build('github', 'person@example.com');
      expect(error.cause).not.toContain('person@example.com');
      expect(error.meta?.['email']).toBe('person@example.com');
    }
  });
});
