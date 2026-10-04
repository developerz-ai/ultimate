/**
 * What moving the OAuth factories must never change: each one's stable code, and the fact that
 * importing the module that holds it registers the titles for them.
 *
 * The factories more than one OAuth module raises live in `./oauth-errors`; one with a single
 * thrower lives beside it. This file imports those modules and never `./errors`, deliberately: the
 * one `registerErrorCodes()` call lives in `errors.ts`, and each subject must reach it through its
 * own import — so a later edit that drops that edge (a locally declared error class, a type-only
 * import) leaves a code unregistered, and `x errors explain` answers a humanised guess instead of
 * the title the package owns. Importing `./errors` here would hide exactly that.
 */

import { describe, expect, test } from 'bun:test';
import { hasErrorCode } from '@ultimat3/core';
import {
  oauthExchangeFailed,
  oauthProviderUnknown,
  oauthStateInvalid,
  oauthTokenInvalid,
  restartAt,
} from './oauth-errors';
import { emailVerifiedNotStored, oauthAccountNotLinked, oauthLinkingDisabled } from './oauth-login';
import { oauthProviderDuplicate } from './oauth-registry';
import { oauthDenied } from './oauth-route';

/**
 * Every OAuth factory, against the code it carries. Codes are forever; `emailVerifiedNotStored`
 * moved OFF `X_NOT_IMPLEMENTED` — an adapter that dropped a write is a runtime fault, and
 * `X_AUTH_WRITE_FAILED` is the code this package already owns for exactly that.
 */
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
  ['X_AUTH_WRITE_FAILED', () => emailVerifiedNotStored('github', 'user-1')],
  ['X_OAUTH_TOKEN_INVALID', () => oauthTokenInvalid('github', 'wrong iss', 'fix the issuer')],
] as const;

describe('the oauth error factories, wherever each lives', () => {
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
