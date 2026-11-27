// The world a mailed-link sign-in is tested in: a memory adapter on a frozen clock, a purpose
// declared `signIn: true`, a verified account and the link mailed to it. Shared by the files that
// test `signInWithLink`, so each stays one subject.

import { type FrozenClock, frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, register } from './auth';
import { FAST_PARAMS, PASSWORD } from './auth-fixture';
import { signInWithLink } from './link-login';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import { defineVerificationPurpose, type VerificationRuntime } from './verify';

export const EMAIL = 'ada@corp.test';
export const SECRET = 'JBSWY3DPEHPK3PXP';
const START = 1_700_000_000_000;
export const TTL_MS = 15 * 60 * 1000;

/**
 * A fresh name per evaluation: the registry is process-wide and refuses a repeat, and this file
 * may be evaluated more than once in one process (`bun test --rerun-each`).
 */
export const freshName = (base: string): string => `${base}-${crypto.randomUUID()}`;

export const signInLink = defineVerificationPurpose({
  name: freshName('link-login-test'),
  template: 'auth.sign-in-link',
  ttlMs: TTL_MS,
  signIn: true,
});

/** Keys on the address as a sign-in link does, and was mailed to do another job. */
export const emailChange = defineVerificationPurpose({
  name: freshName('link-login-test-email-change'),
  template: 'auth.email-change',
  ttlMs: TTL_MS,
});

export interface World {
  readonly auth: Auth;
  readonly adapter: MemoryAuthAdapter;
  readonly clock: FrozenClock;
  readonly runtime: VerificationRuntime;
}

export const world = (): World => {
  const clock = frozenClock(START);
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({
    adapter,
    clock,
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, orgMaxAttempts: 10_000 },
  });
  const runtime = { store: adapter, clock, mail: { send: async () => {} } };
  return { auth, adapter, clock, runtime };
};

/** A registered account that proved its address — the one a link may sign in. */
export const verifiedUser = async ({ auth }: World, email = EMAIL): Promise<string> => {
  const user = await register(auth, { email, password: PASSWORD, orgId: 'org-1' });
  await auth.adapter.updateUser(user.id, { emailVerifiedAt: auth.clock.now() });
  return user.id;
};

export const mailed = async ({ runtime }: World, identifier = EMAIL): Promise<string> =>
  (await signInLink.issue(runtime, { identifier, locale: 'en' })).token;

export const redeem = (auth: Auth, token: string, identifier = EMAIL) =>
  signInWithLink(auth, { purpose: signInLink.name, identifier, token });
