// Password hashing and the one strength rule. Bun's native `Bun.password` is argon2id, so there is
// no dependency to add and no parameter set to invent — only the two knobs OWASP names.

import { MIN_PASSWORD_LENGTH } from '../../shared/auth-policy';
import { PasswordWeak } from './errors';

/**
 * OWASP's argon2id floor (19 MiB, 2 passes). Named rather than defaulted so a change to it is a
 * visible change to the stored hash's `$argon2id$v=19$m=…` prefix, which is what `needsRehash`
 * would one day read — not a silent drift between what two processes wrote.
 */
export const PASSWORD_PARAMS = {
  algorithm: 'argon2id',
  memoryCost: 19_456,
  timeCost: 2,
} as const;

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, PASSWORD_PARAMS);

/**
 * Verification NEVER short-circuits on a missing user: the caller must hash something either way,
 * or the response time itself answers "does this handle exist?" — the same oracle
 * `X_AUTH_CREDENTIALS_INVALID` refuses to be.
 */
export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A stored hash in a format this runtime cannot read is a denial, not a crash — and never an
    // accidental pass. It is also the only way a `verify` throws.
    return false;
  }
};

export const assertPasswordStrength = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH) throw new PasswordWeak(MIN_PASSWORD_LENGTH);
};
