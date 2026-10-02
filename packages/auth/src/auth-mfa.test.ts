// The second leg of a sign-in. The failure case first: `login()` stopped at `X_MFA_REQUIRED`
// handing back a user id, cleared the account's failure window on the way, and shipped nothing to
// finish with — so an app wrote its own completion, and a caller holding the password guessed
// six-digit codes against it unmetered.

import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock, seal } from '@ultimat3/core';
import { type Auth, authenticate, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { MemoryAdapter } from './memory-adapter';
import { generateRecoveryCodes, TOTP_STEP_SECONDS, totpCode, totpStep } from './mfa';
import {
  completeMfa,
  MFA_CHALLENGE_PURPOSE,
  MFA_CHALLENGE_TTL_MS,
  mfaChallengeRequired,
} from './mfa-challenge';
import { openTotpSecret, saveTotpSecret } from './mfa-secret';
import { disableUser } from './revocation';

const EMAIL = 'ada@corp.test';
const SECRET = 'JBSWY3DPEHPK3PXP';
const START = 1_700_000_000_000;

const enrolled = async (): Promise<{ auth: Auth; clock: FrozenClock; userId: string }> => {
  const clock = frozenClock(START);
  const auth = defineAuth({
    adapter: new MemoryAdapter(clock),
    clock,
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, orgMaxAttempts: 10_000 },
  });
  const user = await register(auth, { email: EMAIL, password: PASSWORD, orgId: 'org-1' });
  await saveTotpSecret(auth, user.id, SECRET);
  return { auth, clock, userId: user.id };
};

/** The first leg: the challenge `X_MFA_REQUIRED` carries, as a sign-in handler would read it. */
const challengeFrom = async (auth: Auth): Promise<string> => {
  const error = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
  expect(error?.code).toBe('X_MFA_REQUIRED');
  const challenge = error?.meta?.['challenge'];
  return typeof challenge === 'string' ? challenge : expect.unreachable('no challenge in meta');
};

const codeAt = (clock: FrozenClock, offsetSteps = 0): string =>
  totpCode(SECRET, totpStep(clock.now()) + offsetSteps);

const wrongCode = (clock: FrozenClock): string =>
  [-1, 0, 1].map((offset) => codeAt(clock, offset)).includes('000000') ? '111111' : '000000';

describe('completeMfa finishes what login started', () => {
  test('the challenge and the current code mint a session whose second factor is satisfied', async () => {
    const { auth, clock, userId } = await enrolled();
    const challenge = await challengeFrom(auth);
    expect(await auth.adapter.listSessions(userId)).toHaveLength(0);

    const result = await completeMfa(auth, challenge, codeAt(clock), { ip: '203.0.113.7' });
    expect(result.session.mfaSatisfied).toBe(true);
    expect(result.session.ip).toBe('203.0.113.7');
    expect(result.cookie).toContain('__Host-x_session=');
    // A full actor, not the stripped one a pending second factor resolves to.
    expect((await authenticate(auth, result.token)).id).toBe(userId);
    expect([...result.actor.roles]).toEqual([]);
  });

  test('the challenge names nobody to whoever reads it', async () => {
    const { auth, userId } = await enrolled();
    const error = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
    expect(error?.format()).not.toContain(userId);
    expect(JSON.stringify(error?.meta)).not.toContain(userId);
    expect(error?.fix).toContain('completeMfa(auth, challenge, code)');
  });

  test('a code is good once: the same step does not finish a second sign-in', async () => {
    const { auth, clock } = await enrolled();
    const code = codeAt(clock);
    await completeMfa(auth, await challengeFrom(auth), code);
    const replay = await caught(async () => completeMfa(auth, await challengeFrom(auth), code));
    expect(replay?.code).toBe('X_UNAUTHENTICATED');
  });
});

describe('a challenge completeMfa will not act on', () => {
  const refused = async (auth: Auth, token: unknown, clock: FrozenClock): Promise<string> =>
    (await caught(() => completeMfa(auth, token as string, codeAt(clock))))?.code ?? 'accepted';

  test('a user id, an empty string and a non-string are refused, coded', async () => {
    const { auth, clock, userId } = await enrolled();
    for (const token of [userId, '', 'x1.not.a.seal', undefined, null, 42]) {
      expect(await refused(auth, token, clock)).toBe('X_UNAUTHENTICATED');
    }
  });

  test('a value sealed by this app for another purpose is not a challenge', async () => {
    const { auth, clock, userId } = await enrolled();
    const body = JSON.stringify({ userId, nonce: 'n', expiresAtMs: START + 60_000 });
    const foreign = await seal(body, { purpose: 'entity:connections.password' });
    expect(await refused(auth, foreign, clock)).toBe('X_UNAUTHENTICATED');
    // The same body under the right purpose opens — so the purpose is what refused it.
    const genuine = await seal(body, { purpose: MFA_CHALLENGE_PURPOSE });
    expect(await refused(auth, genuine, clock)).toBe('accepted');
  });

  test('a sealed body that is not a challenge is refused at every missing field', async () => {
    const { auth, clock, userId } = await enrolled();
    const bodies = [
      '[]',
      'null',
      JSON.stringify({ userId, nonce: 'n' }),
      JSON.stringify({ userId, nonce: 'n', expiresAtMs: 'soon' }),
      JSON.stringify({ userId, nonce: 'n', expiresAtMs: null }),
      JSON.stringify({ nonce: 'n', expiresAtMs: START + 60_000 }),
      'not json',
    ];
    for (const body of bodies) {
      const token = await seal(body, { purpose: MFA_CHALLENGE_PURPOSE });
      expect(await refused(auth, token, clock)).toBe('X_UNAUTHENTICATED');
    }
  });

  test('it expires on the server clock, at the instant and not after it', async () => {
    const { auth, clock } = await enrolled();
    const challenge = await challengeFrom(auth);
    clock.advance(MFA_CHALLENGE_TTL_MS - 1);
    expect(await refused(auth, challenge, clock)).toBe('accepted');

    const second = await challengeFrom(auth);
    clock.advance(MFA_CHALLENGE_TTL_MS);
    expect(await refused(auth, second, clock)).toBe('X_UNAUTHENTICATED');
  });

  test('an account disabled, or no longer enrolled, between the legs cannot finish', async () => {
    const disabled = await enrolled();
    const first = await challengeFrom(disabled.auth);
    await disableUser(disabled.auth, disabled.userId, 'offboarded');
    expect(await refused(disabled.auth, first, disabled.clock)).toBe('X_UNAUTHENTICATED');

    const unenrolled = await enrolled();
    const second = await challengeFrom(unenrolled.auth);
    await unenrolled.auth.adapter.updateUser(unenrolled.userId, { mfaSecret: null });
    expect(await refused(unenrolled.auth, second, unenrolled.clock)).toBe('X_UNAUTHENTICATED');
  });

  test('two challenges for one user at one instant are different values', async () => {
    const { auth, userId } = await enrolled();
    const one = (await mfaChallengeRequired(auth, userId)).meta?.['challenge'];
    const two = (await mfaChallengeRequired(auth, userId)).meta?.['challenge'];
    expect(one).not.toBe(two);
  });
});

describe('code guesses are metered by the buckets a password guess spends', () => {
  test('maxAttempts wrong codes lock the account, and the right code is then refused', async () => {
    const { auth, clock } = await enrolled();
    const challenge = await challengeFrom(auth);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await caught(() => completeMfa(auth, challenge, wrongCode(clock)));
      expect(wrong?.code).toBe('X_UNAUTHENTICATED');
    }
    const locked = await caught(() => completeMfa(auth, challenge, codeAt(clock)));
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });

  test('repeating the first leg does not buy the guesses back', async () => {
    const { auth, clock } = await enrolled();
    // The password is known to this caller: each round is one proven first leg and one guess.
    for (let round = 0; round < 5; round += 1) {
      const challenge = await challengeFrom(auth);
      const wrong = await caught(() => completeMfa(auth, challenge, wrongCode(clock)));
      expect(wrong?.code).toBe('X_UNAUTHENTICATED');
    }
    // The sixth round does not even get its first leg: the account is locked.
    const locked = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });

  test('a concurrent burst of 40 guesses checks at most maxAttempts codes', async () => {
    const { auth, clock } = await enrolled();
    const challenge = await challengeFrom(auth);
    const burst = await Promise.all(
      Array.from({ length: 40 }, () =>
        caught(() => completeMfa(auth, challenge, wrongCode(clock))),
      ),
    );
    expect(burst.filter((error) => error?.code === 'X_UNAUTHENTICATED')).toHaveLength(5);
    expect(burst.filter((error) => error?.code === 'X_ACCOUNT_LOCKED')).toHaveLength(35);
  });

  test('a wrong code counts against the address it came from', async () => {
    const { auth, clock } = await enrolled();
    const challenge = await challengeFrom(auth);
    await caught(() => completeMfa(auth, challenge, wrongCode(clock), { ip: '203.0.113.7' }));
    await completeMfa(auth, challenge, codeAt(clock), { ip: '198.51.100.1' });
    // The success cleared the ACCOUNT; the address that guessed wrong still carries its failure.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await caught(() =>
        login(auth, { email: `nobody-${attempt}@corp.test`, password: 'no', ip: '203.0.113.7' }),
      );
    }
    const locked = await caught(() =>
      login(auth, { email: 'nobody@corp.test', password: 'no', ip: '203.0.113.7' }),
    );
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });

  test('the right code after typos clears the account, as a right password does', async () => {
    const { auth, clock } = await enrolled();
    const challenge = await challengeFrom(auth);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await caught(() => completeMfa(auth, challenge, wrongCode(clock)));
    }
    await completeMfa(auth, challenge, codeAt(clock));
    clock.advance(TOTP_STEP_SECONDS * 1000 * 3);
    const next = await challengeFrom(auth);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await caught(() => completeMfa(auth, next, wrongCode(clock))))?.code).toBe(
        'X_UNAUTHENTICATED',
      );
    }
  });
});

/**
 * The seed at rest. It was the one plaintext secret the schema held: a TOTP seed is symmetric, so
 * a dump of `x_users` was every enrolled user's second factor.
 */
describe('the stored secret is sealed, and a plaintext one is never read', () => {
  test('enrolment writes a sealed value that opens back to the secret', async () => {
    const { auth, userId } = await enrolled();
    const stored = (await auth.adapter.findUserById(userId))?.mfaSecret ?? '';
    expect(stored).not.toContain(SECRET);
    expect(stored.startsWith('x1.')).toBe(true);
    expect(await openTotpSecret(stored)).toBe(SECRET);
  });

  test('a secret nothing can derive a code from is refused before it is sealed', async () => {
    const { auth, userId } = await enrolled();
    for (const secret of ['', 'not base32!', undefined]) {
      const refused = await caught(() => saveTotpSecret(auth, userId, secret as string));
      expect(refused?.code).toBe('X_MFA_SECRET_INVALID');
    }
    expect((await caught(() => saveTotpSecret(auth, 'nobody', SECRET)))?.code).toBe(
      'X_AUTH_WRITE_FAILED',
    );
  });

  test('completeMfa refuses a plaintext row with the command that seals it, and counts nothing', async () => {
    const { auth, clock, userId } = await enrolled();
    // The row as a release before sealing left it.
    await auth.adapter.updateUser(userId, { mfaSecret: SECRET });
    const challenge = await challengeFrom(auth);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const refused = await caught(() => completeMfa(auth, challenge, codeAt(clock)));
      expect(refused?.code).toBe('X_MFA_SECRET_UNSEALED');
      expect(refused?.fix).toBe('x auth seal-mfa --json');
      // The correct code for the plaintext seed was presented, and it did not sign anyone in.
      expect(refused?.format()).not.toContain(SECRET);
    }
    expect(await auth.adapter.listSessions(userId)).toHaveLength(0);
    expect(await auth.limiter.lockedUntil(`account:${EMAIL}`)).toBeNull();
  });
});

describe('a recovery code finishes the second factor, once', () => {
  const withCodes = async () => {
    const made = await enrolled();
    const set = generateRecoveryCodes(3);
    await made.auth.adapter.updateUser(made.userId, { recoveryCodeHashes: set.hashes });
    return { ...made, codes: set.codes };
  };

  test('it mints the session and is gone from the row; the others stay', async () => {
    const { auth, userId, codes } = await withCodes();
    const result = await completeMfa(auth, await challengeFrom(auth), codes[0] ?? '');
    expect(result.session.mfaSatisfied).toBe(true);
    expect((await auth.adapter.findUserById(userId))?.recoveryCodeHashes).toHaveLength(2);

    const again = await caught(async () =>
      completeMfa(auth, await challengeFrom(auth), codes[0] ?? ''),
    );
    expect(again?.code).toBe('X_UNAUTHENTICATED');
    // As typed by a person: lower case, spaces for dashes.
    const typed = (codes[1] ?? '').toLowerCase().replaceAll('-', ' ');
    expect((await completeMfa(auth, await challengeFrom(auth), typed)).session.userId).toBe(userId);
  });

  test('two requests carrying one code: exactly one finishes', async () => {
    const { auth, userId, codes } = await withCodes();
    const challenge = await challengeFrom(auth);
    const pair = await Promise.allSettled([
      completeMfa(auth, challenge, codes[0] ?? ''),
      completeMfa(auth, challenge, codes[0] ?? ''),
    ]);
    expect(pair.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(await auth.adapter.listSessions(userId)).toHaveLength(1);
  });

  test('wrong recovery codes are metered exactly as wrong digits are', async () => {
    const { auth, codes } = await withCodes();
    const challenge = await challengeFrom(auth);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await caught(() => completeMfa(auth, challenge, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ'));
      expect(wrong?.code).toBe('X_UNAUTHENTICATED');
    }
    expect((await caught(() => completeMfa(auth, challenge, codes[0] ?? '')))?.code).toBe(
      'X_ACCOUNT_LOCKED',
    );
  });

  test('a store that fails mid-redemption is a fault, and the guess is not counted', async () => {
    const { auth, codes } = await withCodes();
    const challenge = await challengeFrom(auth);
    const down = new TypeError('connection refused');
    const consume = auth.adapter.consumeRecoveryCode.bind(auth.adapter);
    auth.adapter.consumeRecoveryCode = () => Promise.reject(down);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const thrown = await completeMfa(auth, challenge, codes[0] ?? '').catch((e: unknown) => e);
      expect(thrown).toBe(down);
    }
    auth.adapter.consumeRecoveryCode = consume;
    expect((await completeMfa(auth, challenge, codes[0] ?? '')).session.mfaSatisfied).toBe(true);
  });
});
