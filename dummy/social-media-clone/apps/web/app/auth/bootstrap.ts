// The two demo logins' password hashes, written once, lazily.
//
// WHY this file exists at all: `packages/db/src/seed.ts` creates `user` and `admin` and exports
// their passwords as `DEMO_LOGINS`, but seeds no `credentials` row — a hash is not a fixture, it
// is a value only the hashing parameters in `password.ts` can produce, and the seed does not own
// those. So the auth slice writes them, from the passwords the seed already declares.
//
// The rejected alternative was hash-on-first-use ("no credential row? accept whatever was typed
// and store it"). That is not a bootstrap, it is a password reset for anyone who guesses a handle.

import { DEMO_LOGINS } from '@social-media-clone/db';
import { hashPassword } from './password';
import { credentialFor, putCredential, userByHandle } from './repo';

const write = async (handle: string, password: string): Promise<void> => {
  const user = await userByHandle(handle);
  // No seeded user means this is not the demo database — a real deployment, or a test that seeded
  // nothing. Writing a known password into it would be the worst possible kind of helpful.
  if (user === null) return;
  if ((await credentialFor(user.id)) !== null) return;
  await putCredential(user.id, await hashPassword(password));
};

/**
 * Memoized on the PROMISE, not on a boolean: two sign-ins racing the first request would otherwise
 * both see "not done yet" and both insert, and `credentials.userId` is a primary key.
 */
let running: Promise<void> | undefined;

export const ensureDemoCredentials = (): Promise<void> => {
  running ??= (async () => {
    for (const login of DEMO_LOGINS) await write(login.handle, login.password);
  })();
  return running;
};

/** Test seam. A fresh store needs a fresh bootstrap; production boots once. */
export const resetDemoCredentials = (): void => {
  running = undefined;
};
