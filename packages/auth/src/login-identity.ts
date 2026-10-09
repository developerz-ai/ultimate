// Single responsibility: which account a login names — an email, or a handle an app resolves
// through `defineAuth({ handles })` — as the bucket key its failures count against and the lookup
// that finds the user. Both spellings normalise before either is used, so a bucket keyed one way
// and a row found another cannot hand a sprayer a fresh budget per spelling.

import type { AuthUser } from './adapter';
import type { Auth, LoginInput } from './auth';
import { normaliseEmail } from './email';
import { handlesUndeclared } from './errors';
import { accountKey } from './rate-limit';

/** An app's lookup from a normalised handle to the auth user's id, or `null` for nobody. */
export type HandleDirectory = (handle: string) => Promise<string | null>;

/**
 * Trim, then lowercase: a handle differing only in case or surrounding space is one account. The
 * app's lookup receives this form, so its table must store handles the same way.
 */
export const normaliseHandle = (handle: string): string => handle.trim().toLowerCase();

export interface LoginIdentity {
  /** The ACCOUNT bucket — prefixed apart from an email's, so the two namespaces never meet. */
  readonly key: string;
  readonly find: () => Promise<AuthUser | null>;
}

export function loginIdentity(auth: Auth, input: LoginInput): LoginIdentity {
  if (input.handle === undefined) {
    const email = normaliseEmail(input.email);
    return { key: accountKey(email), find: () => auth.adapter.findUserByEmail(email) };
  }
  const handles = auth.handles;
  if (handles === undefined) throw handlesUndeclared();
  const handle = normaliseHandle(input.handle);
  return {
    key: `account-handle:${handle}`,
    async find() {
      const id = await handles(handle);
      return id === null ? null : await auth.adapter.findUserById(id);
    },
  };
}
