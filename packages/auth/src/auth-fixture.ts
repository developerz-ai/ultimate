// Single responsibility: the three values every credential-flow suite needs — cheap KDF
// parameters, the password they all sign in with, and the `AuthError` catcher. Three test files
// share them, and three private copies is three chances for one to drift from what the flow
// actually enforces. Not part of the public API — `index.ts` deliberately does not re-export it.

import { AuthError } from './errors';
import type { PasswordParams } from './password';

// Fast KDF parameters: these tests are about the credential flow, not argon2's cost.
export const FAST_PARAMS: PasswordParams = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 };

export const PASSWORD = 'correct-horse-battery-staple-42';

/** Captures the thrown `AuthError`, or `undefined` when the call unexpectedly resolved. The
 *  caller's `expect(error?.code).toBe(...)` is then the assertion that fails, naming the code it
 *  wanted — a sentinel thrown from in here would carry no code and no fix. Anything that is not
 *  an `AuthError` is rethrown untouched: this helper never swallows an unexpected failure. */
export const caught = async (fn: () => Promise<unknown>): Promise<AuthError | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
};
