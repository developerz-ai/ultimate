// Single responsibility: every flow where a link in an inbox is a credential — email verification
// and password reset built in, any other through `defineVerificationPurpose`, one code path.
// Tokens are single-use, expiring, stored hashed and compared in constant time. Mail leaves through an injected structural `MailSender` port: `@ultimat3/mail` is
// tier 4 and auth is tier 2, so the app wires mail's `send` in and auth imports nothing upward.

import type { Clock } from '@ultimat3/core';
import { timingSafeEqual } from '@ultimat3/core';
import type { AuthVerification, VerificationStore } from './adapter';
import { normaliseEmail } from './email';
import { AuthError } from './errors';
import { assertFiniteAuthCount } from './policy-numbers';
import { randomToken, sha256Hex } from './tokens';
import { registerVerificationPurpose, verificationPurpose } from './verification-purposes';

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

/** The two purposes this package declares itself. Any other is `defineVerificationPurpose`'s. */
export const VERIFICATION_PURPOSES = ['email-verify', 'password-reset'] as const;

/**
 * Open since 30.0: any declared name. A `switch` over it needs a default arm. Undeclared at the
 * call is `X_VERIFICATION_PURPOSE_UNKNOWN`, never a silent default template.
 */
export type VerificationPurpose = string;

type BuiltinPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** Catalog keys, not copy. The template body lives in the app's i18n catalog. */
export const VERIFICATION_TEMPLATES: Readonly<Record<BuiltinPurpose, string>> = {
  'email-verify': 'auth.email-verify',
  'password-reset': 'auth.password-reset',
};

/** Short by default: a reset link is a password, and a password that lives a day is a liability. */
export const DEFAULT_VERIFICATION_TTL_MS: Readonly<Record<BuiltinPurpose, number>> = {
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
  const purpose = verificationPurpose(input.purpose);
  const now = runtime.clock.now();
  const token = randomToken(32);
  // Screened HERE, above the write, not beside the `Date` it feeds. Unscreened this threw a bare
  // `RangeError` out of the package — `new Date(now + NaN)` is an Invalid Date and `toISOString()`
  // refuses one — on the line after `putVerification` had already resolved. The row survived the
  // failure with an expiry `consumeVerification` reads as `now >= NaN`, which is false for ever:
  // a reset link that never expires. And because the write upserts on `(purpose, identifier)`, it
  // had replaced whatever live token that address held on its way to failing.
  const ttl = assertFiniteAuthCount(
    'verification.ttlMs',
    input.ttlMs ?? purpose.ttlMs,
    'the stored expiry is an Invalid Date, `now >= NaN` is false, and the mailed link is a password that never expires',
    1,
  );
  const expiresAt = new Date(now.getTime() + ttl);
  // The FOURTH identity door, and the one that did not normalise: `register`, `login`,
  // `profileEmail` and `accountKey` all do. `putVerification` upserts on `(purpose, identifier)`
  // and `adapter.ts` promises that "issuing a new token invalidates the previous one" — a promise
  // that was per SPELLING, so N live reset tokens for one address could be held at once by varying
  // the case, and each one of them is a password. It is also the address the mail is sent to, so
  // the link goes to the inbox the account is keyed by rather than to whatever a form posted.
  const identifier = purpose.identifier(input.identifier);
  await runtime.store.putVerification({
    id: randomToken(12),
    purpose: purpose.name,
    identifier,
    tokenHash: sha256Hex(token),
    expiresAt,
    consumedAt: null,
    createdAt: now,
  });
  await runtime.mail.send(
    purpose.template,
    identifier,
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
 * The hash goes INTO the consume, it is not compared after one: the store consumes the row only
 * when the hash is the live row's, atomically, so a second redemption finds nothing even if it
 * races the first *and* a wrong guess leaves the row live. Comparing afterwards made an
 * unauthenticated POST with any token at all destroy the victim's emailed link — one request per
 * address for permanent password-reset denial.
 */
export async function consumeVerification(
  runtime: VerificationRuntime,
  input: ConsumeVerificationInput,
): Promise<AuthVerification> {
  const purpose = verificationPurpose(input.purpose);
  const tokenHash = sha256Hex(input.token);
  // Normalised on the way OUT as well as in, or a link issued for `ada@x.test` is unredeemable by
  // a form that posted `Ada@X.test` — one door, one key.
  const record = await runtime.store.takeVerification(
    purpose.name,
    purpose.identifier(input.identifier),
    tokenHash,
  );
  if (record === null) throw verificationInvalid(input.purpose);
  // Kept for the seam, not for the blessed adapters: `VerificationStore` is implementable by an
  // app, and one that ignores the third argument would otherwise redeem any token. Constant-time
  // because this package never compares a secret — or a digest of one — with `===`.
  if (!timingSafeEqual(tokenHash, record.tokenHash)) {
    throw verificationInvalid(input.purpose);
  }
  if (runtime.clock.now().getTime() >= record.expiresAt.getTime()) {
    throw verificationInvalid(input.purpose);
  }
  return record;
}

export interface DefineVerificationPurposeInput {
  /** The store key's first half and the name a consume must repeat. Unique, process-wide. */
  readonly name: string;
  /** The i18n catalog key of the mail: `'auth.member-invite'`. */
  readonly template: string;
  /** Required: how long a mailed credential lives is the app's call, stated once. */
  readonly ttlMs: number;
  /** The identifier's one normalisation. Defaults to `normaliseEmail`, the address door's. */
  readonly identifier?: ((raw: string) => string) | undefined;
}

export interface VerificationPurposeHandle {
  readonly name: string;
  issue(
    runtime: VerificationRuntime,
    input: Omit<IssueVerificationInput, 'purpose'>,
  ): Promise<IssuedVerification>;
  consume(
    runtime: VerificationRuntime,
    input: Omit<ConsumeVerificationInput, 'purpose'>,
  ): Promise<AuthVerification>;
}

/**
 * A single-use mailed credential under its own name — an invite, an email change, an account
 * deletion — on the one code path the two built-ins run: hashed at rest, consumed on a hash
 * match in one atomic step, compared in constant time. Call it at module scope, once.
 */
export function defineVerificationPurpose(
  input: DefineVerificationPurposeInput,
): VerificationPurposeHandle {
  const ttlMs = assertFiniteAuthCount(
    `verification.${input.name}.ttlMs`,
    input.ttlMs,
    'the stored expiry is an Invalid Date and the mailed link is a credential that never expires',
    1,
  );
  registerVerificationPurpose({
    name: input.name,
    template: input.template,
    ttlMs,
    identifier: input.identifier ?? normaliseEmail,
  });
  const name = input.name;
  return {
    name,
    issue: (runtime, rest) => issueVerification(runtime, { ...rest, purpose: name }),
    consume: (runtime, rest) => consumeVerification(runtime, { ...rest, purpose: name }),
  };
}

/** The two built-ins, as instances: one code path for every purpose. */
export const emailVerification = defineVerificationPurpose({
  name: 'email-verify',
  template: VERIFICATION_TEMPLATES['email-verify'],
  ttlMs: DEFAULT_VERIFICATION_TTL_MS['email-verify'],
});

export const passwordReset = defineVerificationPurpose({
  name: 'password-reset',
  template: VERIFICATION_TEMPLATES['password-reset'],
  ttlMs: DEFAULT_VERIFICATION_TTL_MS['password-reset'],
});
