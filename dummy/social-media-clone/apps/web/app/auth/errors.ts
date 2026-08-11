// Every refusal the auth slice can raise. One code per REASON, never one per call site: the code
// is the stable contract and the `fix:` is the command that clears it.

import { UltimateError } from '@ultimat3/core';

/** Every code declared here, so a reader sees the whole surface without grepping for `throw`. */
export const AUTH_ERROR_CODES = [
  'X_AUTH_CREDENTIALS_INVALID',
  'X_AUTH_CAPTCHA_FAILED',
  'X_AUTH_HANDLE_TAKEN',
  'X_AUTH_PASSWORD_WEAK',
] as const;

/**
 * One code for "no such handle" AND for "wrong password", deliberately. Two codes would be an
 * account enumeration oracle: an attacker learns which handles exist by reading which refusal
 * comes back, without ever guessing a password.
 */
export class CredentialsInvalid extends UltimateError {
  constructor() {
    super({
      code: 'X_AUTH_CREDENTIALS_INVALID',
      cause: 'no account matches that handle and password',
      fix: 'curl -sS -X POST "$APP_URL/api/sessions/create" -d handle=user -d password=user',
    });
  }
}

/**
 * Raised when a captcha was demanded and the verifier did not answer "verified" — which includes a
 * timeout, a non-2xx and a body that would not parse. Failing closed is the whole point, so the
 * cause never distinguishes them: "not verified" is one outcome.
 */
export class CaptchaFailed extends UltimateError {
  constructor(verifier: string) {
    super({
      code: 'X_AUTH_CAPTCHA_FAILED',
      cause: `the ${verifier} verifier did not confirm this challenge — a timeout, a non-2xx and an unparsable body all land here`,
      fix: 'unset HCAPTCHA_SECRET HCAPTCHA_SITE_KEY && METRICS_PORT=9391 bun run ../../packages/cli/src/bin.ts dev --port 3877',
      meta: { verifier },
    });
  }
}

export class HandleTaken extends UltimateError {
  constructor(handle: string) {
    super({
      code: 'X_AUTH_HANDLE_TAKEN',
      cause: `@${handle} is already held — a handle is the URL, so it is globally unique`,
      fix: `curl -sS -X POST "$APP_URL/api/accounts/create" -d "handle=${handle}$RANDOM" -d 'displayName=Demo' -d "email=${handle}$RANDOM@demo.example" -d 'password=correct horse battery'`,
      meta: { handle },
    });
  }
}

/**
 * Sign-up only. The two seeded demo logins (`user`/`user`, `admin`/`admin`) are shorter than this
 * and stay valid, because they are bootstrapped rather than registered — a demo whose advertised
 * password its own sign-up form rejects would be a worse lie than a short password.
 */
export class PasswordWeak extends UltimateError {
  constructor(minLength: number) {
    super({
      code: 'X_AUTH_PASSWORD_WEAK',
      cause: `a password must be at least ${minLength} characters`,
      fix: `curl -sS -X POST "$APP_URL/api/accounts/create" -d handle=demo -d 'displayName=Demo' -d email=demo@demo.example -d "password=$(openssl rand -base64 24)"`,
      meta: { minLength },
    });
  }
}
