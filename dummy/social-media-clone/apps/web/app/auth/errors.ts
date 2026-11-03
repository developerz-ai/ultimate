// Every refusal the auth slice can raise. One code per REASON, never one per call site: the code
// is the stable contract and the `fix:` is the command that clears it. Each is declared once, with
// `defineError`: the title, the status a response answers and the class are one call.

import { defineError } from '@ultimat3/core';

/**
 * One code for "no such handle" AND for "wrong password", deliberately. Two codes would be an
 * account enumeration oracle: an attacker learns which handles exist by reading which refusal
 * comes back, without ever guessing a password.
 */
export const CredentialsInvalid = defineError({
  code: 'X_AUTH_CREDENTIALS_INVALID',
  title: 'no account matches that handle and password',
  status: 401,
  cause: 'no account matches that handle and password',
  fix: 'curl -sS -X POST "$APP_URL/api/sessions/create" -d handle=user -d password=user',
});

/**
 * Raised when a captcha was demanded and the verifier did not answer "verified" — which includes a
 * timeout, a non-2xx and a body that would not parse. Failing closed is the whole point, so the
 * cause never distinguishes them: "not verified" is one outcome.
 */
export const CaptchaFailed = defineError<string>({
  code: 'X_AUTH_CAPTCHA_FAILED',
  title: 'the captcha was not verified',
  status: 403,
  cause: (verifier) =>
    `the ${verifier} verifier did not confirm this challenge — a timeout, a non-2xx and an unparsable body all land here`,
  fix: 'unset HCAPTCHA_SECRET HCAPTCHA_SITE_KEY && METRICS_PORT=9391 bun run ../../packages/cli/src/bin.ts dev --port 3877',
  meta: (verifier) => ({ verifier }),
});

export const HandleTaken = defineError<string>({
  code: 'X_AUTH_HANDLE_TAKEN',
  title: 'that handle is already held',
  status: 409,
  cause: (handle) => `@${handle} is already held — a handle is the URL, so it is globally unique`,
  fix: (handle) =>
    `curl -sS -X POST "$APP_URL/api/accounts/create" -d "handle=${handle}$RANDOM" -d 'displayName=Demo' -d "email=${handle}$RANDOM@demo.example" -d 'password=correct horse battery'`,
  meta: (handle) => ({ handle }),
});

/**
 * One account per address: `users.email` and the auth user's both. Sign-up is the one door that
 * names an address, and a refusal here discloses nothing the sign-up form would not — the address
 * was the caller's to type.
 */
export const EmailTaken = defineError({
  code: 'X_AUTH_EMAIL_TAKEN',
  title: 'that email address already has an account',
  status: 409,
  cause: 'an account already uses that email address',
  fix: `curl -sS -X POST "$APP_URL/api/accounts/create" -d "handle=demo$RANDOM" -d 'displayName=Demo' -d "email=demo$RANDOM@demo.example" -d 'password=correct horse battery'`,
});
