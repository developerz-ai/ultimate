// Single responsibility: password hashing, verification and strength. Parameters are explicit
// and stored inside the PHC string, so raising them later is a rehash-on-next-login instead of
// a migration. Verification always burns a full KDF even when the user does not exist —
// otherwise response time answers "is this email registered?" for free.

import { AuthError, passwordWeak } from './errors';
import { kdfGate } from './kdf-gate';

export interface PasswordParams {
  readonly algorithm: 'argon2id';
  /** KiB. OWASP's 2024 floor for argon2id at t=2, p=1. */
  readonly memoryCost: number;
  readonly timeCost: number;
}

export const DEFAULT_PASSWORD_PARAMS: PasswordParams = Object.freeze({
  algorithm: 'argon2id',
  memoryCost: 19_456,
  timeCost: 2,
});

export interface PasswordPolicy {
  readonly minLength: number;
  readonly params: PasswordParams;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = Object.freeze({
  minLength: 12,
  params: DEFAULT_PASSWORD_PARAMS,
});

export interface PasswordVerification {
  readonly ok: boolean;
  /** True when the stored hash used weaker parameters than the current policy. */
  readonly needsRehash: boolean;
}

/** The one shape a failed verification takes. Identical for a wrong password and no user. */
const FAILED: PasswordVerification = Object.freeze({ ok: false, needsRehash: false });

const PHC_RE = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+)/;

/**
 * Passwords that survive any length rule but are the first thing a credential-stuffing list
 * tries. Deliberately tiny: a real deployment layers a breach corpus on top via `extraDenyList`.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  'qwertyuiop',
  '1234567890',
  '123456789012',
  'letmein12345',
  'iloveyou1234',
  'administrator',
  'welcome12345',
  'correcthorse',
]);

/**
 * Through `kdfGate()`, like every other KDF call here: 19 MiB of arena per hash and no per-source
 * limiter that an IPv6 /64 cannot walk around means the ONLY thing bounding argon2 memory on this
 * box is this gate. Past its queue it refuses with `X_OVERLOADED`, the same shed http's `admit`
 * stage performs — a refusal that costs one comparison, not one arena.
 */
export async function hashPassword(
  password: string,
  params: PasswordParams = DEFAULT_PASSWORD_PARAMS,
): Promise<string> {
  return await kdfGate().run(
    async () =>
      await Bun.password.hash(password, {
        algorithm: params.algorithm,
        memoryCost: params.memoryCost,
        timeCost: params.timeCost,
      }),
  );
}

/** Reads the parameters back out of a PHC string. `null` means "not a hash we recognise". */
export function parseHashParams(hash: string): PasswordParams | null {
  const match = PHC_RE.exec(hash);
  if (match === null) return null;
  const variant = match[1];
  const memoryCost = Number.parseInt(match[2] ?? '', 10);
  const timeCost = Number.parseInt(match[3] ?? '', 10);
  if (variant !== 'id' || !Number.isFinite(memoryCost) || !Number.isFinite(timeCost)) return null;
  return { algorithm: 'argon2id', memoryCost, timeCost };
}

/** An unreadable hash, a different algorithm or weaker cost all mean "rehash on next login". */
export function needsRehash(
  hash: string,
  params: PasswordParams = DEFAULT_PASSWORD_PARAMS,
): boolean {
  const stored = parseHashParams(hash);
  if (stored === null) return true;
  return stored.memoryCost < params.memoryCost || stored.timeCost < params.timeCost;
}

export interface VerifyPasswordInput {
  /**
   * `null` when no user matched. The KDF still runs, on a throwaway hash — and a stored hash Bun
   * cannot read takes that same branch, so neither is separable from a wrong password.
   */
  readonly hash: string | null;
  readonly password: string;
  readonly params?: PasswordParams | undefined;
}

/** The KDF the happy path would have burnt, then the one failure shape. Never a cheap answer. */
async function burnAndFail(
  password: string,
  params: PasswordParams,
): Promise<PasswordVerification> {
  await hashPassword(password, params);
  return FAILED;
}

/**
 * `false` is a wrong password, `null` is a stored hash Bun cannot read at all.
 *
 * `Bun.password.verify` THROWS rather than answering on a hash it cannot parse — measured, bun
 * 1.3.14: a Django `pbkdf2_sha256$...` row is `UnsupportedAlgorithm`, a truncated bcrypt string is
 * `InvalidEncoding`. Letting that escape was two faults. A bare `Error` reached `login()`, so the
 * caller answered 500 instead of the one credential failure; and it landed on exactly the rows
 * that have not migrated off the legacy scheme, which makes "has this account been migrated" —
 * and therefore "does this account exist" — readable from the outside. That is the enumeration
 * oracle the whole file is built to close, on the one table where a foreign hash is normal.
 *
 * Supported-but-old is a different thing and stays a verdict: bcrypt verifies natively here and
 * `needsRehash` flags it, which is the lever a legacy migration rewrites rows with.
 *
 * Nothing is logged. The algorithm of an unreadable hash is the oracle again, one layer down.
 */
async function verifyAgainst(password: string, hash: string): Promise<boolean | null> {
  try {
    return await kdfGate().run(async () => await Bun.password.verify(password, hash));
  } catch (error) {
    // The gate shedding (`X_OVERLOADED`) is load, never a verdict on the credential: swallowing it
    // would answer "wrong password" for a request this process refused to do the work for.
    if (error instanceof AuthError) throw error;
    return null;
  }
}

/**
 * Never short-circuits on a missing user: the `hashPassword` call in the `null` branch costs
 * the same order of magnitude as the verify in the happy branch, so the two are not separable
 * by a stopwatch. Callers must map `ok: false` to `loginFailed()` and nothing more specific.
 */
export async function verifyPassword(input: VerifyPasswordInput): Promise<PasswordVerification> {
  const params = input.params ?? DEFAULT_PASSWORD_PARAMS;
  // Read into a local so the two branches below narrow it without a cast.
  const hash = input.hash;
  // `''` joins the no-user branch rather than reaching the KDF: an account with no password
  // credential (oauth-only) answers `false` from Bun for free, and a failure that costs nothing
  // is a stopwatch away from "this address exists but has never set a password".
  if (hash === null || hash === '') return await burnAndFail(input.password, params);
  const ok = await verifyAgainst(input.password, hash);
  if (ok === null) return await burnAndFail(input.password, params);
  if (!ok) return FAILED;
  return { ok: true, needsRehash: needsRehash(hash, params) };
}

export interface StrengthOptions {
  readonly policy?: PasswordPolicy | undefined;
  readonly extraDenyList?: ReadonlySet<string> | undefined;
}

/** Throws `X_PASSWORD_WEAK` listing every reason at once — one round trip, not a guessing game. */
export function checkPasswordStrength(password: string, options?: StrengthOptions): void {
  const policy = options?.policy ?? DEFAULT_PASSWORD_POLICY;
  const normalised = password.trim().toLowerCase();
  const reasons: string[] = [];

  if (password.length < policy.minLength) {
    reasons.push(`it is ${password.length} characters, the policy requires ${policy.minLength}`);
  }
  if (COMMON_PASSWORDS.has(normalised) || options?.extraDenyList?.has(normalised) === true) {
    reasons.push('it appears in the known-password deny list');
  }
  if (password.length > 0 && new Set(password).size <= 2) {
    reasons.push('it uses two or fewer distinct characters');
  }
  if (reasons.length > 0) throw passwordWeak(reasons);
}
