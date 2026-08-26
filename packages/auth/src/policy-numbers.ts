// Single responsibility: the numeric screen over every option this package bounds anything with —
// the three policies `defineAuth` resolves, and the runtime options (`jwks`, the OAuth legs, TOTP
// drift, the limiter's key cap) that arrive on a call rather than through config. One file, because
// the rule is one rule: a duration, a length and an allowance are all "a whole positive number, and
// NaN is what an unset environment variable parses to".

import { authPolicyNumberInvalid } from './errors';
import type { PasswordPolicy } from './password';
import type { AuthRateLimitPolicy } from './rate-limit';
import type { SessionPolicy } from './session';

const WHOLE_POSITIVE = 'a whole number greater than zero';
const WHOLE_NON_NEGATIVE = 'a whole number of zero or more';

/**
 * `Number.isSafeInteger`, not `Number.isFinite`: these are millisecond durations and attempt
 * counts, and past 2^53 a double cannot name its own successor — a "duration" up there is already
 * a rounded one, and `now + it` no longer moves.
 *
 * The `Finite` in the name is load-bearing: `bun run finite-bounds` recognises a repair by the
 * shape of the CALL, so a screen named `whole` left every call site reading as unchecked.
 */
export function assertFiniteAuthCount(
  key: string,
  value: number,
  consequence: string,
  min: 0 | 1,
): number {
  if (Number.isSafeInteger(value) && value >= min) return value;
  throw authPolicyNumberInvalid(
    key,
    value,
    min === 1 ? WHOLE_POSITIVE : WHOLE_NON_NEGATIVE,
    consequence,
  );
}

/** Both clocks and the slide between them. A session that never expires is the failure here. */
export function assertSessionPolicy(policy: SessionPolicy): void {
  assertFiniteAuthCount(
    'session.absoluteTtlMs',
    policy.absoluteTtlMs,
    'the absolute expiry becomes an Invalid Date and `now >= NaN` is false, so the session never expires on that clock',
    1,
  );
  assertFiniteAuthCount(
    'session.idleTtlMs',
    policy.idleTtlMs,
    '`now - lastSeenAt >= NaN` is false, so a session idle for years still reports itself live',
    1,
  );
  if (policy.idleSlideMs !== undefined) {
    assertFiniteAuthCount(
      'session.idleSlideMs',
      policy.idleSlideMs,
      'the write that moves `lastSeenAt` forward is skipped or taken on every single request',
      0,
    );
  }
}

/** The length rule, and the two KDF costs that decide what a stolen hash is worth. */
export function assertPasswordPolicy(policy: PasswordPolicy): void {
  assertFiniteAuthCount(
    'password.minLength',
    policy.minLength,
    '`password.length < NaN` is false for every password, and the two-distinct-characters rule is guarded by `length > 0`, so the EMPTY password is accepted',
    1,
  );
  assertFiniteAuthCount(
    'password.params.memoryCost',
    policy.params.memoryCost,
    'argon2 refuses it several frames below the config line that set it, on the first registration',
    1,
  );
  assertFiniteAuthCount(
    'password.params.timeCost',
    policy.params.timeCost,
    'argon2 refuses it several frames below the config line that set it, on the first registration',
    1,
  );
}

/**
 * The lockout numbers. These were already refused — by `assertAuthLimiterPolicy`, whose `NaN ===
 * NaN` comparison fails — but as `X_AUTH_LIMITER_POLICY_MISMATCH`, which tells an operator the
 * limiter enforces different numbers than the app declared. It does not: the number is a typo.
 */
export function assertRateLimitPolicy(policy: AuthRateLimitPolicy): void {
  assertFiniteAuthCount(
    'rateLimit.maxAttempts',
    policy.maxAttempts,
    '`failures.length >= NaN` is false, so the lockout never engages and guessing is unlimited',
    1,
  );
  assertFiniteAuthCount(
    'rateLimit.windowMs',
    policy.windowMs,
    'every recorded failure falls outside the window immediately, so nothing ever accumulates',
    1,
  );
  assertFiniteAuthCount(
    'rateLimit.lockoutMs',
    policy.lockoutMs,
    '`now < lockedUntil` is false, so a lockout that was established holds nobody',
    1,
  );
  if (policy.orgMaxAttempts !== undefined) {
    assertFiniteAuthCount(
      'rateLimit.orgMaxAttempts',
      policy.orgMaxAttempts,
      'the tenant bucket never fills, so one org can saturate the shared limiter',
      1,
    );
  }
  if (policy.maxKeys !== undefined) {
    assertFiniteAuthCount(
      'rateLimit.maxKeys',
      policy.maxKeys,
      'the in-memory table has no ceiling, so a spray of distinct keys is memory the attacker chooses',
      1,
    );
  }
}
