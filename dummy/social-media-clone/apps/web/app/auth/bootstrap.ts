// The two demo logins' auth users, written once, lazily.
//
// WHY this file exists at all: `packages/db/src/seed.ts` creates `user` and `admin` and exports
// their passwords as `DEMO_LOGINS`, but writes no auth user — a hash is not a fixture, it is a value
// only the password parameters `appAuth()` holds can produce, and the seed does not own those. So
// the auth slice writes them, from the passwords the seed already declares, under the `users` rows'
// own ids. They are shorter than sign-up allows (`MIN_PASSWORD_LENGTH`) and stay valid, because
// they are bootstrapped here rather than registered: a demo whose advertised password its own
// sign-up form rejects would be a worse lie than a short password.
//
// The rejected alternative was hash-on-first-use ("no auth user? accept whatever was typed and
// store it"). That is not a bootstrap, it is a password reset for anyone who guesses a handle.

import { DEMO_LOGINS } from '@social-media-clone/db';
import { hashPassword } from '@ultimat3/auth';
import { appAuth } from './auth';
import { userByHandle } from './repo';

const write = async (handle: string, password: string): Promise<void> => {
  const user = await userByHandle(handle);
  // No seeded user means this is not the demo database — a real deployment, or a test that seeded
  // nothing. Writing a known password into it would be the worst possible kind of helpful.
  if (user === null) return;
  const auth = appAuth();
  if ((await auth.adapter.findUserById(user.id)) !== null) return;
  try {
    await auth.adapter.createUser({
      id: user.id,
      email: user.email,
      passwordHash: await hashPassword(password, auth.password.params),
      orgId: null,
      roles: [],
      createdAt: auth.clock.now(),
    });
  } catch (error) {
    // Another process — the demo runs four role containers on one database — wrote it between the
    // read and the insert. Its row is the same user with the same password; anything else throws.
    if ((await auth.adapter.findUserById(user.id)) === null) throw error;
  }
};

/**
 * Memoized on the PROMISE, not on a boolean: two sign-ins racing the first request would otherwise
 * both see "not done yet" and both insert, and `x_users.id` is a primary key. Across processes the
 * second insert is refused by that key, and the next sign-in finds the row the first one wrote.
 */
let running: Promise<void> | undefined;

export const ensureDemoCredentials = (): Promise<void> => {
  running ??= (async () => {
    for (const login of DEMO_LOGINS) await write(login.handle, login.password);
  })().catch((error: unknown) => {
    // A failed bootstrap is retried by the next sign-in, never remembered as the answer.
    running = undefined;
    throw error;
  });
  return running;
};

/** Test seam. A fresh store needs a fresh bootstrap; production boots once. */
export const resetDemoCredentials = (): void => {
  running = undefined;
};
