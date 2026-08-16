// Single responsibility: password hashing, verification and strength. Parameters are explicit
// and stored inside the PHC string, so raising them later is a rehash-on-next-login instead of
// a migration. Verification always burns a full KDF even when the user does not exist —
// otherwise response time answers "is this email registered?" for free.

import { passwordWeak } from './errors';
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
  /** `null` when no user matched. The KDF still runs, on a throwaway hash. */
  readonly hash: string | null;
  readonly password: string;
  readonly params?: PasswordParams | undefined;
}

/**
 * Never short-circuits on a missing user: the `hashPassword` call in the `null` branch costs
 * the same order of magnitude as the verify in the happy branch, so the two are not separable
 * by a stopwatch. Callers must map `ok: false` to `loginFailed()` and nothing more specific.
 */
export async function verifyPassword(input: VerifyPasswordInput): Promise<PasswordVerification> {
  const params = input.params ?? DEFAULT_PASSWORD_PARAMS;
  // Read into a local so the closure below narrows without a cast.
  const hash = input.hash;
  if (hash === null) {
    await hashPassword(input.password, params);
    return FAILED;
  }
  const ok = await kdfGate().run(async () => await Bun.password.verify(input.password, hash));
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
