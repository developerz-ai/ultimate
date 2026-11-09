// Single responsibility: a wrong second-factor code counts against the TENANT bucket, as a wrong
// password does in `login()`. Without it a spray of guessed codes across a tenant's members, one
// per account and one per address, met no cap at all — every per-account bucket stays under its own.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { memoryAuthAdapter } from './memory-adapter';
import { totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { saveTotpSecret } from './mfa-secret';

const SECRET = 'JBSWY3DPEHPK3PXP';
const START = 1_700_000_000_000;
const MEMBERS = ['a@corp.test', 'b@corp.test', 'c@corp.test', 'd@corp.test'];

const challengeOf = async (auth: Auth, email: string): Promise<string> => {
  const error = await caught(() => login(auth, { email, password: PASSWORD }));
  const challenge = error?.meta?.['challenge'];
  return typeof challenge === 'string' ? challenge : expect.unreachable('no challenge in meta');
};

describe('the tenant bucket covers the second factor', () => {
  test('wrong codes across members and addresses are capped by the org', async () => {
    const clock = frozenClock(START);
    const auth = defineAuth({
      adapter: memoryAuthAdapter(clock),
      clock,
      password: { minLength: 12, params: FAST_PARAMS },
      rateLimit: { maxAttempts: 50, orgMaxAttempts: 3 },
    });
    for (const email of MEMBERS) {
      const user = await register(auth, { email, password: PASSWORD, orgId: 'org-1' });
      await saveTotpSecret(auth, user.id, SECRET);
    }
    const now = totpStep(clock.now());
    const live = [now - 1, now, now + 1].map((step) => totpCode(SECRET, step));
    const wrong = live.includes('000000') ? '111111' : '000000';

    // Every first leg BEFORE any guess: a password leg spends the tenant bucket too, and this is
    // about what the second leg spends.
    const challenges: string[] = [];
    for (const email of MEMBERS) challenges.push(await challengeOf(auth, email));
    // Three members, three addresses: one wrong code each, so no account bucket sees two.
    for (const [index, challenge] of challenges.slice(0, 3).entries()) {
      const failure = await caught(() =>
        completeMfa(auth, challenge, wrong, { ip: `203.0.113.${index}` }),
      );
      expect(failure?.code).not.toBe('X_ACCOUNT_LOCKED');
    }
    // The fourth member, a fresh address, the RIGHT code: refused by the tenant cap.
    const fourth = challenges[3] ?? expect.unreachable('four challenges');
    const locked = await caught(() =>
      completeMfa(auth, fourth, totpCode(SECRET, now), { ip: '203.0.113.99' }),
    );
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });
});
