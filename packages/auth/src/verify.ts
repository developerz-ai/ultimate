// Single responsibility: email verification and password reset — the two flows where a link in
// an inbox is a credential. Tokens are single-use, expiring, stored hashed and compared in
// constant time. Mail leaves through an injected `MailSender` port: the app wires
// `@ultimat3/mail`'s `send` into it, because auth must not depend on a sideways tier-3 package.

import type { Clock } from '@ultimat3/core';
import type { AuthVerification, VerificationStore } from './adapter';
import { AuthError } from './errors';
import { randomToken, sha256Hex, timingSafeEqual } from './tokens';

/**
 * `locale` is required, not optional: an inferred locale is how a user gets a security email
 * in a language they cannot read. `@ultimat3/mail`'s `send` is the production binding.
 */
export interface MailSender {
  send(
    template: string,
    to: string,
    data: Readonly<Record<string, unknown>>,
    locale: string,
  ): Promise<void>;
}

export const VERIFICATION_PURPOSES = ['email-verify', 'password-reset'] as const;

export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** Catalog keys, not copy. The template body lives in the app's i18n catalog. */
export const VERIFICATION_TEMPLATES: Readonly<Record<VerificationPurpose, string>> = {
  'email-verify': 'auth.email-verify',
  'password-reset': 'auth.password-reset',
};

/** Short by default: a reset link is a password, and a password that lives a day is a liability. */
export const DEFAULT_VERIFICATION_TTL_MS: Readonly<Record<VerificationPurpose, number>> = {
  'email-verify': 24 * 60 * 60 * 1000,
  'password-reset': 60 * 60 * 1000,
};

export interface VerificationRuntime {
  readonly store: VerificationStore;
  readonly clock: Clock;
  readonly mail: MailSender;
}

export interface IssueVerificationInput {
  readonly purpose: VerificationPurpose;
  /** The email address. Also the store key — one live token per purpose per address. */
  readonly identifier: string;
  readonly locale: string;
  readonly ttlMs?: number | undefined;
  /** Builds the URL that carries the token. Defaults to the token alone. */
  readonly link?: ((token: string) => string) | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface IssuedVerification {
  /** Returned so a test or a CLI can assert on it. Production only ever mails it. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issueVerification(
  runtime: VerificationRuntime,
  input: IssueVerificationInput,
): Promise<IssuedVerification> {
  const now = runtime.clock.now();
  const token = randomToken(32);
  const ttl = input.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS[input.purpose];
  const expiresAt = new Date(now.getTime() + ttl);
  await runtime.store.putVerification({
    id: randomToken(12),
    purpose: input.purpose,
    identifier: input.identifier,
    tokenHash: sha256Hex(token),
    expiresAt,
    consumedAt: null,
    createdAt: now,
  });
  await runtime.mail.send(
    VERIFICATION_TEMPLATES[input.purpose],
    input.identifier,
    {
      ...(input.data ?? {}),
      link: input.link?.(token) ?? token,
      expiresAt: expiresAt.toISOString(),
    },
    input.locale,
  );
  return { token, expiresAt };
}

/**
 * One error for "no such token", "already used", "expired" and "wrong token". Distinguishing
 * them tells an attacker which address has a live reset in flight.
 */
const verificationInvalid = (purpose: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `the ${purpose} token is unknown, already used, expired or does not match`,
    fix: `request a new link — ${purpose} tokens are single-use`,
  });

export interface ConsumeVerificationInput {
  readonly purpose: VerificationPurpose;
  readonly identifier: string;
  readonly token: string;
}

/**
 * The store consumes the row atomically, so a second redemption finds nothing even if it
 * races the first. The hash comparison happens after, on the row we already own.
 */
export async function consumeVerification(
  runtime: VerificationRuntime,
  input: ConsumeVerificationInput,
): Promise<AuthVerification> {
  const record = await runtime.store.takeVerification(input.purpose, input.identifier);
  if (record === null) throw verificationInvalid(input.purpose);
  if (runtime.clock.now().getTime() >= record.expiresAt.getTime()) {
    throw verificationInvalid(input.purpose);
  }
  if (!timingSafeEqual(sha256Hex(input.token), record.tokenHash)) {
    throw verificationInvalid(input.purpose);
  }
  return record;
}
